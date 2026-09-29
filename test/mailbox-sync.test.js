import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mailboxFailureReason, normalizeImapPassword, protectImapClient, savedSuccessMailboxes } from '../mailbox-sync.js';

test('Google app-password formatting is normalized without changing other providers or passwords', () => {
 assert.equal(normalizeImapPassword('user@gmail.com', 'abcd efgh ijkl mnop'), 'abcdefghijklmnop');
 assert.equal(normalizeImapPassword('user@googlemail.com', 'abcd efgh ijkl mnop'), 'abcdefghijklmnop');
 assert.equal(normalizeImapPassword('user@yahoo.com', 'abcd efgh ijkl mnop'), 'abcd efgh ijkl mnop');
 assert.equal(normalizeImapPassword('user@gmail.com', 'different password'), 'different password');
});
test('post-connect socket errors are handled instead of crashing the website', () => {
 const client = protectImapClient(new EventEmitter());
 const error = Object.assign(new Error('synthetic timeout'), { code: 'ETIMEDOUT' });
 assert.doesNotThrow(() => client.emit('error', error));
 assert.equal(client.successMailboxError, error);
 assert.equal(mailboxFailureReason(error), 'connection_timeout');
});
test('diagnostics distinguish auth, network and command failures without leaking raw responses', () => {
 assert.equal(mailboxFailureReason({ authenticationFailed: true, message: 'private credentials' }), 'authentication_failed');
 assert.equal(mailboxFailureReason({ code: 'ENOTFOUND' }), 'dns_failed');
 assert.equal(mailboxFailureReason({ code: 'ECONNRESET' }), 'connection_closed');
 assert.equal(mailboxFailureReason({ responseStatus: 'BAD', message: 'private email content' }), 'mailbox_command_rejected');
 assert.equal(mailboxFailureReason({ message: 'private email content' }), 'mailbox_scan_failed');
});
test('additional saved email logins are included once and inherit the signup cutoff', () => {
 const entries = [{ email: 'USER@gmail.com', password: 'new app password' }, { email: 'user@gmail.com', password: 'duplicate' }, { email: 'second@yahoo.com', password: 'second' }, { email: 'missing@gmail.com' }];
 const mailboxes = savedSuccessMailboxes(entries, '2026-09-01T00:00:00Z');
 assert.equal(mailboxes.length, 2);
 assert.equal(mailboxes[0].email, 'user@gmail.com');
 assert.equal(mailboxes[0].password, 'new app password');
 assert.ok(mailboxes.every(box => box.signedUpAt === '2026-09-01T00:00:00Z'));
});
