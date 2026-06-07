import { google } from 'googleapis'

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']

function getOAuthClient() {
  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const redirectUri = process.env.GMAIL_REDIRECT_URI

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Missing GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET or GMAIL_REDIRECT_URI environment variable')
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri)
}

export function getAuthUrl() {
  const oauth2Client = getOAuthClient()
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
}

export async function getTokensFromCode(code: string) {
  const oauth2Client = getOAuthClient()
  const { tokens } = await oauth2Client.getToken(code)
  return tokens
}

export function getGmailClient(accessToken: string, refreshToken?: string) {
  const oauth2Client = getOAuthClient()
  oauth2Client.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
  })
  return google.gmail({ version: 'v1', auth: oauth2Client })
}

export interface RawEmail {
  id: string
  threadId: string
  subject: string
  from: string
  fromName: string
  to: string[]
  cc: string[]
  date: string
  snippet: string
  body: string
  unread: boolean
  labelIds: string[]
}

function decodeBase64(str: string): string {
  try {
    return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8')
  } catch {
    return ''
  }
}

// Fix 11: proper HTML stripping that preserves table structure
// Converts HTML booking confirmations into readable plain text
function stripHtml(html: string): string {
  return html
    // Preserve table cell boundaries as spaces
    .replace(/<\/td>/gi, ' | ')
    .replace(/<\/th>/gi, ' | ')
    // Preserve row boundaries as newlines
    .replace(/<\/tr>/gi, '\n')
    // Preserve block element boundaries
    .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    // Strip remaining tags
    .replace(/<[^>]+>/g, '')
    // Decode HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code)))
    // Clean up whitespace while preserving newlines
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 0)
    .join('\n')
    .trim()
}

function extractBody(payload: any): string {
  if (!payload) return ''

  // Direct body
  if (payload.body?.data) {
    const decoded = decodeBase64(payload.body.data)
    return payload.mimeType === 'text/html' ? stripHtml(decoded) : decoded
  }

  // Multipart - prefer text/plain, fallback to text/html
  if (payload.parts) {
    const plain = payload.parts.find((p: any) => p.mimeType === 'text/plain')
    if (plain?.body?.data) return decodeBase64(plain.body.data)

    const html = payload.parts.find((p: any) => p.mimeType === 'text/html')
    if (html?.body?.data) {
      return stripHtml(decodeBase64(html.body.data))
    }

    // Nested multipart
    for (const part of payload.parts) {
      const nested = extractBody(part)
      if (nested) return nested
    }
  }

  return ''
}

function getHeader(headers: any[], name: string): string {
  return headers?.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || ''
}

function parseEmailAddresses(header: string): string[] {
  if (!header) return []
  return header
    .split(/[,;]+/)
    .map(a => a.trim())
    .filter(Boolean)
}

function parseFromName(from: string): { email: string; name: string } {
  const match = from.match(/^"?([^"<]+)"?\s*<?([^>]*)>?$/)
  if (match) {
    return {
      name: match[1].trim(),
      email: match[2].trim() || match[1].trim(),
    }
  }
  return { name: from, email: from }
}

export async function fetchEmailById(gmail: any, id: string): Promise<RawEmail | null> {
  try {
    const res = await gmail.users.messages.get({ userId: 'me', id, format: 'full' })
    const msg = res.data
    const headers = msg.payload?.headers || []
    const from = getHeader(headers, 'from')
    const { name: fromName, email: fromEmail } = parseFromName(from)
    return {
      id: msg.id,
      threadId: msg.threadId,
      subject: getHeader(headers, 'subject') || '(no subject)',
      from: fromEmail,
      fromName,
      to: parseEmailAddresses(getHeader(headers, 'to')),
      cc: parseEmailAddresses(getHeader(headers, 'cc')),
      date: getHeader(headers, 'date'),
      snippet: msg.snippet || '',
      body: extractBody(msg.payload).slice(0, 8000),
      unread: (msg.labelIds || []).includes('UNREAD'),
      labelIds: msg.labelIds || [],
    }
  } catch {
    return null
  }
}

export async function fetchEmails(
  gmail: any,
  options: {
    maxResults?: number
    pageToken?: string
    query?: string
    labelIds?: string[]
  } = {}
): Promise<{ emails: RawEmail[]; nextPageToken?: string }> {
  const { maxResults = 50, pageToken, query = 'in:inbox', labelIds } = options

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    maxResults,
    pageToken,
    q: query,
    labelIds,
  })

  const messages = listRes.data.messages || []
  const nextPageToken = listRes.data.nextPageToken

  if (messages.length === 0) return { emails: [], nextPageToken }

  const batchSize = 10
  const emails: RawEmail[] = []

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize)
    const results = await Promise.all(
      batch.map((msg: any) =>
        gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full',
        })
      )
    )

    for (const res of results) {
      const msg = res.data
      const headers = msg.payload?.headers || []
      const from = getHeader(headers, 'from')
      const { name: fromName, email: fromEmail } = parseFromName(from)

      emails.push({
        id: msg.id,
        threadId: msg.threadId,
        subject: getHeader(headers, 'subject') || '(no subject)',
        from: fromEmail,
        fromName,
        to: parseEmailAddresses(getHeader(headers, 'to')),
        cc: parseEmailAddresses(getHeader(headers, 'cc')),
        date: getHeader(headers, 'date'),
        snippet: msg.snippet || '',
        // Fix 10: increased to 8000 chars to capture full booking confirmations
        body: extractBody(msg.payload).slice(0, 8000),
        unread: (msg.labelIds || []).includes('UNREAD'),
        labelIds: msg.labelIds || [],
      })
    }
  }

  return { emails, nextPageToken }
}
