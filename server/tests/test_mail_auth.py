"""Шар выбило из ящика: отказ почтового сервера в пароле — это «введите пароль заново» (409 и
needsPassword), а не «сервер не ответил» (502), как было раньше."""

import imaplib

from app.modules.mail import crypto


def test_auth_errors_recognized():
    assert crypto.is_auth_error(imaplib.IMAP4.error("b'[AUTHENTICATIONFAILED] Authentication failed.'"))
    assert crypto.is_auth_error(RuntimeError("LOGIN failed"))
    assert crypto.is_auth_error(crypto.MailPasswordUnavailable("x"))
    assert not crypto.is_auth_error(TimeoutError("timed out"))
    assert not crypto.is_auth_error(ConnectionRefusedError("[WinError 10061] connection refused"))


def test_needs_password_follows_rejection_and_relogin():
    acc = {'id': 'acc-auth-test', 'password_enc': crypto._obfuscate_pw('secret')}
    assert not crypto.needs_password(acc)
    crypto.mark_password(acc['id'], False)
    assert crypto.needs_password(acc)
    crypto.mark_password(acc['id'], True)
    assert not crypto.needs_password(acc)


def test_undecryptable_password_needs_password():
    assert crypto.needs_password({'id': 'acc-bad-key', 'password_enc': 'enc1:not-a-token'})
