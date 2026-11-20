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


class Offline(http.Controller):

    @http.route('/web/offline/sync', type='jsonrpc', auth='user', methods=['POST'])
    def sync(self, db, uid, key, model, method, args, kwargs, refs=None):
        """Replay a single change as the authenticated owner and return its ORM result.

        `refs` lists keys of earlier creates. In `args` and `kwargs`, a JSON
        string `offline:<key>` for a listed key is replaced with its record id.
        """
        env = request.env
        if type(uid) is not int or uid != env.uid or db != request.db:
            raise SessionExpiredException(env._("Log in as the user who made this change to send it."))
        if refs is None:
            refs = []
        if not (
            _is_operation_key(key)
            and isinstance(model, str) and isinstance(method, str)
            and isinstance(args, list) and isinstance(kwargs, dict)
            and isinstance(refs, list) and all(_is_operation_key(ref) for ref in refs)
        ):
            raise ValidationError(env._("Invalid offline change."))
        return env['web.offline.operation']._apply(key, model, method, args, kwargs, refs)
