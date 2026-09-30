import { ImapFlow } from 'imapflow';
ImapFlow.prototype.connect = async function () {
  if (this.options.auth.pass === 'synthetic-invalid-password') {
    const error = new Error('Authentication failed'); error.authenticationFailed = true; throw error;
  }
  this.usable = true;
};
ImapFlow.prototype.logout = async function () { this.usable = false; };
ImapFlow.prototype.close = function () { this.usable = false; };
