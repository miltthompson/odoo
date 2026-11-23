# Part of Odoo. See LICENSE file for full copyright and licensing details.

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, RLock
from unittest.mock import patch
from uuid import uuid4

from odoo import SUPERUSER_ID, api, fields
from odoo.exceptions import AccessError, RedirectWarning, ValidationError
from odoo.http.retrying import retrying
from odoo.modules.registry import Registry
from odoo.service.model import call_kw
from odoo.tests import HttpCase, new_test_user, tagged
from odoo.tests.common import BaseCase, get_db_name
from odoo.tools import SQL, mute_logger


class TestOfflineSync(HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.alice = new_test_user(cls.env, login='offline_alice', groups='base.group_user,base.group_partner_manager')
        cls.bob = new_test_user(cls.env, login='offline_bob')

    def _send(self, key, *, owner=None, db=None, **change):
        return self.url_open('/web/offline/sync', json={'params': {
            'db': db or self.env.cr.dbname,
            'uid': (owner or self.alice).id,
            'key': key,
            **change,
        }}).json()

    def _sync(self, key, method, args, *, owner=None, model='res.partner', refs=None, db=None):
        return self._send(key, owner=owner, db=db, model=model, method=method, args=args, kwargs={}, refs=refs or [])

    def test_replay_returns_previous_result(self):
        self.authenticate(self.alice.login, self.alice.login)
        key = str(uuid4())
        vals = {'name': 'Offline once', 'comment': 'Original response'}
        first = self._sync(key, 'web_save', [[], vals, {'comment': {}}])['result']
        second = self._sync(key, 'web_save', [[], vals, {'comment': {}}])['result']
        self.assertEqual(first, second)
        partner = self.env['res.partner'].search([('name', '=', vals['name'])])
        self.assertEqual(partner.ids, [first[0]['id']])
        self.assertEqual(partner.create_uid, self.alice)

    def test_refs_only_resolve_creates_by_the_current_owner(self):
        self.authenticate(self.alice.login, self.alice.login)
        create_key = str(uuid4())
        [partner_id] = self._sync(create_key, 'create', [[{'name': 'Offline contact'}]])['result']
        update_key = str(uuid4())
        args = [[f'offline:{create_key}'], {'name': 'Updated contact'}]
        self.authenticate(self.bob.login, self.bob.login)
        error = self._sync(update_key, 'write', args, owner=self.bob, refs=[create_key])['error']
        self.assertEqual(error['data']['name'], 'odoo.exceptions.MissingError')
        self.authenticate(self.alice.login, self.alice.login)
        self.assertTrue(self._sync(update_key, 'write', args, refs=[create_key])['result'])
        self.assertEqual(self.env['res.partner'].browse(partner_id).name, 'Updated contact')

    def test_owner_checked_before_replay(self):
        self.authenticate(self.bob.login, self.bob.login)
        key = str(uuid4())
        self.assertEqual(self._sync(key, 'create', [{'name': 'Wrong owner'}])['error']['code'], 100)
        self.assertEqual(self._sync(key, 'create', [{'name': 'Wrong database'}],
                                   owner=self.bob, db='another-db')['error']['code'], 100)
        self.assertFalse(self.env['web.offline.operation'].search([('key', '=', key)]))

    def test_administrator_can_read_metadata_but_not_payload(self):
        operation = self.env['web.offline.operation'].create({
            'user_id': self.alice.id, 'key': str(uuid4()), 'result': {'response': 'Private'},
        })
        as_admin = operation.with_user(self.env.ref('base.user_admin'))
        self.assertEqual(as_admin.read(['key'])[0]['key'], operation.key)
        for name in ('result', 'created_ids'):
            with self.assertRaises(AccessError):
                as_admin.read([name])

    def test_late_replay_does_not_apply_twice_after_purging_result(self):
        self.authenticate(self.alice.login, self.alice.login)
        create_key, update_key, recent_key = (str(uuid4()) for _ in range(3))
        args = [[], {'name': 'Offline contact', 'comment': 'Private response'}, {'comment': {}}]
        [created] = self._sync(create_key, 'web_save', args)['result']
        partner_id = created['id']
        self.assertTrue(self._sync(update_key, 'write', [[partner_id], {'name': 'Changed online'}])['result'])
        self.assertTrue(self._sync(recent_key, 'write', [[partner_id], {'phone': '888'}])['result'])
        Operation = self.env['web.offline.operation']
        purged = Operation.search([('key', 'in', [create_key, update_key])])
        recent = Operation.search([('key', '=', recent_key)])
        self.env.cr.execute(SQL(
            'UPDATE web_offline_operation SET create_date = %s WHERE id IN %s',
            fields.Datetime.subtract(fields.Datetime.now(), days=31), tuple(purged.ids),
        ))
        purged.invalidate_recordset(['create_date'])
        Operation._gc_applied_offline_operations()
        self.assertEqual(purged.mapped('result'), [False, False])
        self.assertTrue(recent.result['response'])

        self.assertEqual(self._sync(create_key, 'web_save', args)['result'], {
            'already_applied': True, 'created_ids': [partner_id],
        })
        self.assertEqual(self._sync(update_key, 'write', [[partner_id], {'name': 'Do not replay'}])['result'], {
            'already_applied': True, 'created_ids': [],
        })
        self.assertFalse(self.env['res.partner'].search([('name', '=', 'Offline contact')]))
        self.assertEqual(self.env['res.partner'].browse(partner_id).name, 'Changed online')
        ref_args = [[f'offline:{create_key}'], {'name': 'Resolved after cutoff'}]
        self.assertTrue(self._sync(str(uuid4()), 'write', ref_args, refs=[create_key])['result'])
        self.assertEqual(self.env['res.partner'].browse(partner_id).name, 'Resolved after cutoff')

    def test_ordered_steps_resolve_earlier_creates_and_replay_once(self):
        self.authenticate(self.alice.login, self.alice.login)
        key = str(uuid4())
        steps = [
            {'model': 'res.partner', 'method': 'create', 'args': [{'name': 'Before'}], 'kwargs': {}},
            {'model': 'res.partner', 'method': 'write', 'args': [['step:0'], {'name': 'After'}], 'kwargs': {}, 'refs': [0]},
        ]
        results = self._send(key, steps=steps)['result']
        self.assertEqual(results, self._send(key, steps=steps)['result'])
        self.assertTrue(results[1])
        self.assertEqual(self.env['res.partner'].search([('name', '=', 'After')]).ids, [results[0]])
        self.assertEqual(self.env['web.offline.operation'].search_count([('key', '=', key)]), 1)

    @mute_logger('odoo.http')
    def test_failed_step_rolls_back_earlier_calls_and_reservation(self):
        self.authenticate(self.alice.login, self.alice.login)
        key = str(uuid4())
        steps = [
            {'model': 'res.partner', 'method': 'create', 'args': [{'name': 'Must roll back'}], 'kwargs': {}},
            {'model': 'res.users', 'method': 'write', 'args': [self.bob.ids, {'name': 'Must not change'}], 'kwargs': {}},
        ]
        self.assertEqual(self._send(key, steps=steps)['error']['data']['name'], 'odoo.exceptions.AccessError')
        self.assertFalse(self.env['res.partner'].search([('name', '=', 'Must roll back')]))
        self.assertFalse(self.env['web.offline.operation'].search([('key', '=', key)]))
        self.assertTrue(self._send(key, steps=steps[:1])['result'])

    @mute_logger('odoo.http')
    def test_replay_error_confirms_rollback_after_partial_create(self):
        self.authenticate(self.alice.login, self.alice.login)
        for exception in (ValidationError('Invalid draft'), RedirectWarning('Review draft', 1, 'Open')):
            with self.subTest(exception=type(exception).__name__):
                key = str(uuid4())

                def dispatch(model, method, args, kwargs):
                    call_kw(model, method, args, kwargs)
                    raise exception

                with patch('odoo.addons.web.models.web_offline_operation.call_kw', side_effect=dispatch):
                    error = self._sync(key, 'web_save', [[], {'name': key}, {}])['error']['data']
                self.assertEqual(error['name'], f'odoo.exceptions.{type(exception).__name__}')
                self.assertIs(error['offline_replay_rolled_back'], True)
                self.assertFalse(self.env['res.partner'].search([('name', '=', key)]))
                self.assertFalse(self.env['web.offline.operation'].search([('key', '=', key)]))

    @mute_logger('odoo.http')
    def test_postcommit_error_does_not_confirm_rollback(self):
        self.authenticate(self.alice.login, self.alice.login)
        key = str(uuid4())
        args = [[], {'name': key}, {}]

        def fail_after_commit():
            raise ValidationError('A post-commit callback failed')

        def dispatch(model, method, args, kwargs):
            result = call_kw(model, method, args, kwargs)
            model.env.cr.postcommit.add(fail_after_commit)
            return result

        with patch('odoo.addons.web.models.web_offline_operation.call_kw', side_effect=dispatch):
            error = self._sync(key, 'web_save', args)['error']['data']
        self.assertEqual(error['name'], 'odoo.exceptions.ValidationError')
        self.assertNotIn('offline_replay_rolled_back', error)
        [receipt] = self._sync(key, 'web_save', args)['result']
        self.assertEqual(self.env['res.partner'].search([('name', '=', key)]).ids, [receipt['id']])

    @mute_logger('odoo.http')
    def test_replay_rejects_transaction_control_and_can_be_retried(self):
        self.authenticate(self.alice.login, self.alice.login)
        for cursor_method in ('commit', 'rollback'):
            with self.subTest(cursor_method=cursor_method):
                key = str(uuid4())
                name = f'Offline contact before {cursor_method}'
                partner_domain = [('name', '=', name)]
                operation_domain = [('user_id', '=', self.alice.id), ('key', '=', key)]
                steps = [
                    {'model': 'res.partner', 'method': 'create', 'args': [{'name': name}], 'kwargs': {}},
                    {'model': 'res.partner', 'method': 'write', 'args': [['step:0'], {'phone': '555'}], 'kwargs': {}, 'refs': [0]},
                ]

                def dispatch(model, method, args, kwargs):
                    if method == 'write':
                        getattr(model.env.cr, cursor_method)()
                    return call_kw(model, method, args, kwargs)

                with patch('odoo.addons.web.models.web_offline_operation.call_kw', side_effect=dispatch):
                    error = self._send(key, steps=steps)['error']['data']
                self.assertEqual(error['name'], 'builtins.AssertionError')
                self.assertIn(f'cannot {cursor_method}', error['message'])
                self.assertFalse(self.env['res.partner'].search(partner_domain))
                self.assertFalse(self.env['web.offline.operation'].search(operation_domain))

                results = self._send(key, steps=steps)['result']
                self.assertEqual(results, self._send(key, steps=steps)['result'])
                partner = self.env['res.partner'].search(partner_domain)
                self.assertEqual(partner.ids, [results[0]])
                self.assertEqual(partner.phone, '555')
                self.assertEqual(self.env['web.offline.operation'].search_count(operation_domain), 1)

    @mute_logger('odoo.http')
    def test_regular_rpc_access_checks(self):
        self.authenticate(self.alice.login, self.alice.login)
        key = str(uuid4())
        error = self._sync(key, 'write', [self.bob.ids, {'name': 'Not authorized'}], model='res.users')['error']
        self.assertEqual(error['data']['name'], 'odoo.exceptions.AccessError')
        error = self._sync(key, '_compute_display_name', [[]])['error']
        self.assertEqual(error['data']['name'], 'odoo.exceptions.AccessError')
        error = self._sync(key, 'search_read', [[]], model='web.offline.operation')['error']
        self.assertEqual(error['data']['name'], 'odoo.exceptions.AccessError')
        self.assertFalse(self.env['web.offline.operation'].search([('key', '=', key)]))


@tagged('-standard', 'database_breaking')  # Requires independent committing database cursors.
class TestOfflineSyncConcurrency(BaseCase):

    @mute_logger('odoo.sql_db')
    def test_concurrent_replay(self):
        registry = Registry(get_db_name())
        key = str(uuid4())
        start = Barrier(2, timeout=10)
        domain = [('key', '=', key)]
        partner_domain = [('name', '=', key)]

        def cleanup():
            with registry.cursor() as cr:
                env = api.Environment(cr, SUPERUSER_ID, {})
                env['web.offline.operation'].search(domain).unlink()
                env['res.partner'].search(partner_domain).unlink()

        self.addCleanup(cleanup)

        def send(env):
            start.wait()
            return retrying(
                lambda: env['web.offline.operation']._apply(key, 'res.partner', 'create', [{'name': key}], {}, []),
                env, close_on_commit=False,
            )

        with registry.cursor() as cr1, registry.cursor() as cr2:
            envs = [api.Environment(cr, SUPERUSER_ID, {}) for cr in (cr1, cr2)]
            # Take both repeatable-read snapshots before allowing either insert.
            for env in envs:
                self.assertFalse(env['web.offline.operation'].search(domain))

            # The test runner holds the normal registry lock. Use a separate
            # lock for these workers without replacing their real DB cursors.
            with patch.object(Registry, '_lock', RLock()), ThreadPoolExecutor(max_workers=2) as executor:
                first, second = [executor.submit(send, env) for env in envs]
                partner_id = first.result(timeout=20)
                self.assertEqual(second.result(timeout=20), partner_id)

        with registry.cursor() as cr:
            env = api.Environment(cr, SUPERUSER_ID, {})
            self.assertEqual(env['res.partner'].search(partner_domain).ids, [partner_id])
            self.assertEqual(env['web.offline.operation'].search_count(domain), 1)
