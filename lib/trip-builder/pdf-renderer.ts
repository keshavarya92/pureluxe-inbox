// Renders a self-contained HTML string (from html-builder.ts) to a PDF
// buffer via headless Chromium. Two code paths, chosen by environment:
//
//   - Vercel/serverless: puppeteer-core + @sparticuz/chromium, the standard
//     Vercel-compatible combo (both packages are in Next's built-in
//     serverExternalPackages list, so no next.config changes are needed).
//     @sparticuz/chromium only ships a Linux binary — it cannot run locally
//     on this Windows dev machine.
//   - Local dev: the full `puppeteer` package (devDependency only — it
//     bundles a real cross-platform Chromium download), dynamically
//     imported so it's never required in the deployed bundle.

// `puppeteer` (local dev) and `puppeteer-core` (serverless) ship separate,
// structurally-near-identical type packages — rather than force-cast
// between them, launchBrowser only promises the handful of members this
// module actually calls.
interface MinimalPage {
  setContent(html: string, opts: { waitUntil: 'load' }): Promise<void>
  pdf(opts: Record<string, unknown>): Promise<Uint8Array>
}
interface MinimalBrowser {
  newPage(): Promise<MinimalPage>
  close(): Promise<void>
}

async function launchBrowser(): Promise<MinimalBrowser> {
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME)

  if (isServerless) {
    const chromium = (await import('@sparticuz/chromium')).default
    const puppeteer = await import('puppeteer-core')
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    })
  }

  // Local dev only — devDependency, dynamically imported so it's never
  // bundled/required outside this branch.
  const puppeteer = await import('puppeteer')
  return puppeteer.launch({ headless: true })
}

export async function renderHtmlToPdf(html: string): Promise<Buffer> {
  const browser = await launchBrowser()
  try {
    const page = await browser.newPage()
    // The HTML is fully self-contained (inline CSS, base64 logo) — no
    // external network fetches to wait for beyond the load event.
    await page.setContent(html, { waitUntil: 'load' })
    const pdf = await page.pdf({
      format: 'letter',
      printBackground: true,
      margin: { top: '20px', bottom: '40px', left: '0px', right: '0px' },
      displayHeaderFooter: false, // the HTML already includes its own header/footer bars
    })
    return Buffer.from(pdf)
  } finally {
    await browser.close()
  }
}
