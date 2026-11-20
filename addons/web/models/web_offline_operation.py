# Part of Odoo. See LICENSE file for full copyright and licensing details.

import json

from psycopg2.errors import UniqueViolation

from odoo import api, fields, models
from odoo.exceptions import ConcurrencyError, MissingError
from odoo.service.model import call_kw
from odoo.tools.json import json_default


def _replace_refs(value, ids_by_ref):
    if isinstance(value, list):
        return [_replace_refs(item, ids_by_ref) for item in value]
    if isinstance(value, dict):
        return {key: _replace_refs(item, ids_by_ref) for key, item in value.items()}
    if isinstance(value, str):
        return ids_by_ref.get(value, value)
    return value


def _created_ids(method, args, kwargs, response):
    ids = []
    if method == 'web_save' and args and not args[0] and len(args) < 4 and not kwargs.get('next_id'):
        if isinstance(response, list) and len(response) == 1 and isinstance(response[0], dict):
            ids = [response[0].get('id')]
    elif method == 'create':
        ids = response if isinstance(response, list) else [response]
    return [record_id for record_id in ids if type(record_id) is int and record_id > 0]


class WebOfflineOperation(models.Model):
    _name = 'web.offline.operation'
    _description = 'Applied Offline Change'
    _rec_name = 'key'

    user_id = fields.Many2one('res.users', required=True, ondelete='cascade')
    key = fields.Char(required=True)
    # The payload may contain values administrators cannot read on the source model.
    result = fields.Json(groups=fields.NO_ACCESS)
    created_ids = fields.Json(groups=fields.NO_ACCESS)

    _user_key_unique = models.Constraint('UNIQUE(user_id, key)')
    _create_date_index = models.Index('(create_date) WHERE result IS NOT NULL')

    @api.model
    def _apply(self, key, model=None, method=None, args=None, kwargs=None, refs=None, *, steps=None):
        uid = self.env.uid
        # Regular users cannot access the log. Only log access is elevated;
        # the business call below uses the same environment as dataset/call_kw.
        Log = self.sudo()
        previous = Log.search([('user_id', '=', uid), ('key', '=', key)], limit=1)
        if previous:
            if previous.result:
                return previous.result['response']
            return {'already_applied': True, 'created_ids': previous.created_ids or []}

        # Reserve before invoking the method. The HTTP transaction commits the
        # reservation and business write together, or rolls both back.
        try:
            operation = Log.create({'user_id': uid, 'key': key})
        except UniqueViolation as exc:
            if exc.diag.constraint_name != self._user_key_unique.full_name(self):
                raise
            # A concurrent commit is not visible to our repeatable-read
            # snapshot. Let Odoo restart the request with a fresh snapshot.
            raise ConcurrencyError('Offline operation already reserved') from exc

        calls = steps if steps is not None else [{'model': model, 'method': method, 'args': args, 'kwargs': kwargs, 'refs': refs or []}]
        external_refs = {ref for call in calls for ref in call.get('refs', []) if isinstance(ref, str)}
        ids_by_ref = {}
        if external_refs:
            dependencies = Log.search([('user_id', '=', uid), ('key', 'in', list(external_refs))])
            for dependency in dependencies:
                if len(dependency.created_ids or []) == 1:
                    ids_by_ref[dependency.key] = dependency.created_ids[0]

        results = []
        created_by_step = []
        for call in calls:
            replacements = {}
            for ref in call.get('refs', []):
                if isinstance(ref, str) and ref in ids_by_ref:
                    replacements[f'offline:{ref}'] = ids_by_ref[ref]
                elif type(ref) is int and len(created_by_step[ref]) == 1:
                    replacements[f'step:{ref}'] = created_by_step[ref][0]
                else:
                    raise MissingError(self.env._("An earlier offline change did not create a single record."))
            args = _replace_refs(call['args'], replacements) if replacements else call['args']
            kwargs = _replace_refs(call['kwargs'], replacements) if replacements else call['kwargs']
            method = call['method']
            result = call_kw(self.env[call['model']], method, args, kwargs)
            results.append(result)
            created_by_step.append(_created_ids(method, args, kwargs, result))

        response = results if steps is not None else results[0]
        # Normalize dates and other values the same way as the JSON-RPC transport.
        response = json.loads(json.dumps(response, default=json_default))
        operation.write({
            'result': {'response': response},
            'created_ids': [record_id for ids in created_by_step for record_id in ids],
        })
        return response

    @api.autovacuum
    def _gc_applied_offline_operations(self):
        cutoff = fields.Datetime.subtract(fields.Datetime.now(), days=30)
        self.search([('create_date', '<', cutoff), ('result', '!=', False)]).result = False
