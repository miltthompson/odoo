# Part of Odoo. See LICENSE file for full copyright and licensing details.

from uuid import uuid4

from odoo import fields
from odoo.tests import HttpCase, new_test_user
from odoo.tools import SQL, mute_logger


class TestOfflineSync(HttpCase):

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.alice = new_test_user(cls.env, login='offline_alice', groups='base.group_user,base.group_partner_manager')
        cls.bob = new_test_user(cls.env, login='offline_bob')

    def _sync(self, key, method, args, *, owner=None, model='res.partner', refs=None, db=None):
        return self.url_open('/web/offline/sync', json={'params': {
            'db': db or self.env.cr.dbname,
            'uid': (owner or self.alice).id,
            'key': key,
            'model': model,
            'method': method,
            'args': args,
            'kwargs': {},
            'refs': refs or [],
        }}).json()

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
        partner_id = self._sync(create_key, 'create', [{'name': 'Offline contact'}])['result']
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

    def test_vacuum_retains_recent_operations(self):
        Operation = self.env['web.offline.operation']
        old, recent = Operation.create([{'user_id': self.alice.id, 'key': str(uuid4())} for _ in range(2)])
        self.env.cr.execute(SQL(
            'UPDATE web_offline_operation SET create_date = %s WHERE id = %s',
            fields.Datetime.subtract(fields.Datetime.now(), days=31), old.id,
        ))
        Operation._gc_applied_offline_operations()
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

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
