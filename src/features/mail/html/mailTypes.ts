export interface EmailAccount {
  id: string;
  name: string;
  email: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  username: string;
  useSsl: boolean;
  signature?: string;
}

export interface EmailAddress {
  addr: string;
  name?: string;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
  url?: string;
}

export interface EmailMessage {
  id: string;
  accountId: string;
  uid?: string;
  folder: string;
  messageId?: string;
  threadId?: string;
  subject: string;
  fromAddr: string;
  fromName: string;
  toAddrs: EmailAddress[];
  ccAddrs: EmailAddress[];
  bccAddrs: EmailAddress[];
  bodyText: string;
  bodyHtml: string;
  attachments: Attachment[];
  isRead: boolean;
  isStarred: boolean;
  isDraft: boolean;
  date: string;
  // client-side optimistic state
  _pending?: boolean;
  _error?: boolean;
}

export interface Thread {
  threadId: string;
  subject: string;
  messages: EmailMessage[];
  lastDate: string;
  unread: boolean;
  fromNames: string[];
}

export type Folder = 'INBOX' | 'SENT' | 'DRAFTS' | 'SPAM' | 'TRASH';

// Custom mail folder (Gmail-label style) — a saved name/color; which mail
// lands in it is decided by MailFolderRule patterns, not a real IMAP move.
export interface MailFolder {
  id: string;
  name: string;
  color: string;
}

export interface MailFolderRule {
  id: string;
  folderId: string;
  emailPattern: string;
}

export interface ParsedEmail {
  body: string;        // clean main text
  signature: string;  // stripped signature (for display as muted)
  quote: { from: string; subject: string; date: string; body: string } | null;
}

export interface ChatBgProps {
  color: string;
  image?: string;
  overlay?: string;
  overlayScale?: number;
  overlayOpacity?: number;
}
