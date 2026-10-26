"""Папки почты: русские имена в modified UTF-7, вложенность, разделитель NIL, имя литералом.
Раньше распознавались только «Входящие», а «Отправленные» с русским именем читались как INBOX."""

from app.modules.mail import imap

LIST = [
    rb'(\HasNoChildren) "/" INBOX',
    rb'(\HasNoChildren) "/" "&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"',  # Отправленные
    rb'(\HasNoChildren) "/" "&BCcENQRABD0EPgQyBDgEOgQ4-"',  # Черновики
    rb'(\HasNoChildren) "/" "&BBoEPgRABDcEOAQ9BDA-"',  # Корзина
    rb'(\HasNoChildren) "/" "&BCEEPwQwBDw-"',  # Спам
    rb'(\HasChildren) "/" "&BB8EQAQ+BDUEOgRCBEs-"',  # Проекты
    rb'(\HasNoChildren) "/" "&BB8EQAQ+BDUEOgRCBEs-/&BBAEOwRMBEQEMA-"',  # Проекты/Альфа
    rb'(\Noselect \HasChildren) "/" "[Gmail]"',
    rb'(\All \HasNoChildren) "/" "[Gmail]/All Mail"',
    rb'(\HasNoChildren) NIL Notes',
    (rb'(\HasNoChildren) "/" {11}', b'Client "VIP"'),
]


class FakeConn:
    def list(self):
        return 'OK', LIST

    def logout(self):
        pass


def test_folders_decoded_and_classified(monkeypatch):
    monkeypatch.setattr(imap, '_imap_connect', lambda acc: FakeConn())
    roles, others = imap._mail_folders({'id': 'test-folders'}, force=True)
    assert roles == {'inbox': 'INBOX', 'sent': 'Отправленные', 'drafts': 'Черновики', 'trash': 'Корзина', 'junk': 'Спам'}
    assert [(o['folder'], o['title'], o['depth']) for o in others] == [
        ('Client "VIP"', 'Client "VIP"', 0),
        ('Notes', 'Notes', 0),
        ('Проекты', 'Проекты', 0),
        ('Проекты/Альфа', 'Альфа', 1),
    ]


def test_flag_beats_name(monkeypatch):
    data = [rb'(\HasNoChildren) "." "INBOX.Sent"', rb'(\HasNoChildren \Sent) "." "INBOX.Sent Messages"']

    class Conn(FakeConn):
        def list(self):
            return 'OK', data

    monkeypatch.setattr(imap, '_imap_connect', lambda acc: Conn())
    roles, others = imap._mail_folders({'id': 'test-flags'}, force=True)
    assert roles['sent'] == 'INBOX.Sent Messages'
    assert [o['title'] for o in others] == ['Sent']


def test_wire_name_is_encoded_and_quoted():
    assert imap._wire('Отправленные') == b'"&BB4EQgQ,BEAEMAQyBDsENQQ9BD0ESwQ1-"'
    assert imap._wire('Sent Items') == b'"Sent Items"'
