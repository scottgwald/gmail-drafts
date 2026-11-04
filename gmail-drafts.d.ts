export type GmailApi = (path: string, opts?: RequestInit) => Promise<any>;

export interface MailAttachment { id: string; name: string; mime: string; size: number }
export interface AttachmentFile { name: string; mime: string; bytes: Uint8Array }
export interface DraftFields { cc: string; bcc: string; reply_to: string; date: string; in_reply_to: string; attachments: MailAttachment[] }
export interface ReplyOpts { cc?: string; bcc?: string; quote?: boolean }
export interface ComposeOpts { cc?: string; bcc?: string }
export interface UpdateOpts { cc?: string; bcc?: string }

export interface ReplyResult { draftId: string; to: string; subject: string; from?: string; cc?: string; bcc?: string; quoted: boolean }
export interface ComposeResult { draftId: string; to: string; subject: string; cc?: string; bcc?: string }
export interface DraftListItem extends Partial<DraftFields> { draft_id: string; thread_id?: string | null; to?: string; subject?: string }
export interface DraftListResult { drafts: DraftListItem[]; total: number }
export interface DraftGetResult extends DraftFields { draft_id: string; thread_id: string | null; from: string; to: string; subject: string; body: string; body_truncated: boolean }
export interface UpdateResult { draftId: string; threadId: string | null }

export interface DraftOps {
  reply(threadId: string, bodyText: string, opts?: ReplyOpts): Promise<ReplyResult>;
  compose(to: string, subject: string, bodyText: string, opts?: ComposeOpts): Promise<ComposeResult>;
  list(): Promise<DraftListResult>;
  get(draftId: string): Promise<DraftGetResult>;
  update(draftId: string, bodyText: string, to?: string, subject?: string, opts?: UpdateOpts): Promise<UpdateResult>;
  delete(draftId: string): Promise<void>;
  /** The bytes of a message's attachments, as files for gmailRawMime. */
  attachmentFiles(message: any): Promise<AttachmentFile[]>;
}

export function createDraftOps(api: GmailApi): DraftOps;
export function gmailRestApi(
  getToken: () => Promise<string> | string,
  opts?: { fetch?: typeof fetch; base?: string },
): GmailApi;
/** multipart/alternative (text/plain format=flowed quoted-printable + html); with attachments, inside multipart/mixed. */
export function gmailRawMime(headers: Array<[string, string]>, bodyText: string, opts?: { attachments?: AttachmentFile[] }): string;
export function quotedPrintable(text: string): string;
export function flowedText(text: string): string;
export function htmlOfText(text: string): string;
export function mailHeader(msg: any, name: string): string;
export function mailPartText(payload: any, want: string): string;
export function mailHtmlToText(html: string): string;
export function mailBodyText(payload: any): string;
export function mailAttachments(payload: any): MailAttachment[];
