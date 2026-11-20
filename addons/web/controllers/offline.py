# Part of Odoo. See LICENSE file for full copyright and licensing details.

from uuid import UUID

from odoo import http
from odoo.exceptions import ValidationError
from odoo.http import request
from odoo.http.session import SessionExpiredException


def _is_operation_key(value):
    if not isinstance(value, str) or len(value) != 36:
        return False
    try:
        return str(UUID(value)) == value
    except ValueError:
        return False


def _is_call(call, index=0):
    if not isinstance(call, dict) or call.keys() - {'model', 'method', 'args', 'kwargs', 'refs'}:
        return False
    refs = call.get('refs', [])
    return (
        isinstance(call.get('model'), str) and isinstance(call.get('method'), str)
        and isinstance(call.get('args'), list) and isinstance(call.get('kwargs'), dict)
        and isinstance(refs, list) and all(
            _is_operation_key(ref) or (type(ref) is int and 0 <= ref < index)
            for ref in refs
        )
    )


class Offline(http.Controller):

    @http.route('/web/offline/sync', type='jsonrpc', auth='user', methods=['POST'])
    def sync(self, db, uid, key, model=None, method=None, args=None, kwargs=None, refs=None, steps=None):
        """Replay one change as its authenticated owner.

        A single call returns its ORM result. An atomic `steps` list returns one
        ORM result per step. Listed UUID refs replace `offline:<key>` with a
        previous create's ID. In steps, listed zero-based indices also replace
        `step:<index>` with the ID created by that earlier step.
        """
        env = request.env
        if type(uid) is not int or uid != env.uid or db != request.db:
            raise SessionExpiredException(env._("Log in as the user who made this change to send it."))
        if not _is_operation_key(key):
            raise ValidationError(env._("Invalid offline change."))

        Operation = env['web.offline.operation']
        if steps is None:
            call = {'model': model, 'method': method, 'args': args, 'kwargs': kwargs, 'refs': [] if refs is None else refs}
            if not _is_call(call):
                raise ValidationError(env._("Invalid offline change."))
            return Operation._apply(key, **call)
        if (any(value is not None for value in (model, method, args, kwargs, refs))
            or not isinstance(steps, list) or not steps
            or not all(_is_call(step, index) for index, step in enumerate(steps))
        ):
            raise ValidationError(env._("Invalid offline change."))
        return Operation._apply(key, steps=steps)
