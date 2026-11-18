export type GmailApi = (path: string, opts?: RequestInit) => Promise<any>;

export interface MailAttachment { id: string; name: string; mime: string; size: number }
export interface AttachmentFile { name: string; mime: string; bytes: Uint8Array }
export interface DraftFields { cc: string; bcc: string; reply_to: string; date: string; in_reply_to: string; attachments: MailAttachment[] }
export interface ReplyOpts { cc?: string; bcc?: string; quote?: boolean }
export interface ComposeOpts { cc?: string; bcc?: string }
export interface UpdateOpts { cc?: string; bcc?: string }

/** own_thread: the thread held no incoming message, so To (and Cc) are those of your own last message. */
export interface ReplyResult { draftId: string; to: string; subject: string; from?: string; cc?: string; bcc?: string; quoted: boolean; own_thread?: boolean }
export interface ComposeResult { draftId: string; to: string; subject: string; cc?: string; bcc?: string }
/** saved: ISO time Gmail last saved the draft ("" when unknown); first_line: the body's first non-empty line, 120 characters at most. */
export interface DraftListItem extends Partial<DraftFields> { draft_id: string; thread_id?: string | null; from?: string; to?: string; subject?: string; saved?: string; attachment_count?: number; first_line?: string }
export interface DraftListResult { drafts: DraftListItem[]; total: number }
export interface GetOpts { /** the whole body instead of the first 4000 characters */ full?: boolean }
/** message_id: the Gmail message id; rfc_message_id: the RFC 822 Message-ID header; size: Gmail's sizeEstimate of the raw message; body_chars: the body's real length. */
export interface DraftGetResult extends DraftFields {
  draft_id: string; thread_id: string | null; message_id: string | null; from: string; to: string; subject: string;
  saved: string; rfc_message_id: string; references: string; labels: string[]; size: number; has_html: boolean; inline_count: number;
  body: string; body_chars: number; body_truncated: boolean; full?: true;
}
export interface UpdateResult { draftId: string; threadId: string | null }

export interface DraftOps {
  reply(threadId: string, bodyText: string, opts?: ReplyOpts): Promise<ReplyResult>;
  compose(to: string, subject: string, bodyText: string, opts?: ComposeOpts): Promise<ComposeResult>;
  list(): Promise<DraftListResult>;
  get(draftId: string, opts?: GetOpts): Promise<DraftGetResult>;
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
/** RFC 2047: a non-ASCII header value as folded UTF-8 "B" encoded-words; ASCII unchanged; already-encoded input is not encoded twice. */
export function mimeHeaderEncode(value: string): string;
/** RFC 2047 encoded-words back to text. */
export function mimeHeaderDecode(value: string): string;
/** An address header (To, Cc, Bcc, From, Reply-To) for the wire: a non-ASCII display name as encoded-words, the <addr> never; an all-ASCII header unchanged. */
export function mimeAddressEncode(value: string): string;
/** An address header for display: encoded display names back to text, quoted again when they need it. */
export function mimeAddressDecode(value: string): string;
export function quotedPrintable(text: string): string;
export function flowedText(text: string): string;
export function htmlOfText(text: string): string;
export function mailHeader(msg: any, name: string): string;
export function mailPartText(payload: any, want: string): string;
export function mailHtmlToText(html: string): string;
export function mailBodyText(payload: any): string;
export function mailAttachments(payload: any): MailAttachment[];
/** Parts with a Content-ID or an inline disposition that are files (a logo, a pasted picture). */
export function mailInlineCount(payload: any): number;
