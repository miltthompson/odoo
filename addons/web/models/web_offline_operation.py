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


def _created_id(method, args, kwargs, response):
    if method == 'web_save' and args and not args[0] and len(args) < 4 and not kwargs.get('next_id'):
        if isinstance(response, list) and len(response) == 1 and isinstance(response[0], dict):
            return response[0].get('id')
    if method == 'create':
        if isinstance(response, list) and len(response) == 1:
            response = response[0]
        if type(response) is int and response > 0:
            return response
    return None


class WebOfflineOperation(models.Model):
    _name = 'web.offline.operation'
    _description = 'Applied Offline Change'
    _rec_name = 'key'

    user_id = fields.Many2one('res.users', required=True, ondelete='cascade')
    key = fields.Char(required=True)
    # The payload may contain values administrators cannot read on the source model.
    result = fields.Json(groups=fields.NO_ACCESS)

    _user_key_unique = models.Constraint('UNIQUE(user_id, key)')
    _create_date_index = models.Index('(create_date)')

    @api.model
    def _apply(self, key, model, method, args, kwargs, refs):
        uid = self.env.uid
        # Regular users cannot access the log. Only log access is elevated;
        # the business call below uses the same environment as dataset/call_kw.
        Log = self.sudo()
        previous = Log.search([('user_id', '=', uid), ('key', '=', key)], limit=1)
        if previous:
            return previous.result['response']

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

        if refs:
            dependencies = Log.search([('user_id', '=', uid), ('key', 'in', refs)])
            ids_by_ref = {
                f'offline:{dep.key}': dep.result['created_id']
                for dep in dependencies
                if dep.result and dep.result.get('created_id')
            }
            if any(f'offline:{ref}' not in ids_by_ref for ref in refs):
                raise MissingError(self.env._("An earlier offline change that creates a record has not been applied."))
            args = _replace_refs(args, ids_by_ref)
            kwargs = _replace_refs(kwargs, ids_by_ref)

        response = call_kw(self.env[model], method, args, kwargs)
        # Normalize dates and other values the same way as the JSON-RPC transport.
        response = json.loads(json.dumps(response, default=json_default))
        operation.result = {'response': response, 'created_id': _created_id(method, args, kwargs, response)}
        return response

    @api.autovacuum
    def _gc_applied_offline_operations(self):
        self.search([('create_date', '<', fields.Datetime.subtract(fields.Datetime.now(), days=30))]).unlink()
