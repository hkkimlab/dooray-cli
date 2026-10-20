// Organization SSO → Dooray personal token, driving a browser with Playwright.
// Opens the tenant's Dooray (https://<domain>.gov-dooray.com), which redirects to the organization's
// sign-in page, fills that page's sign-in form, then creates the token on Dooray's /setting/api page.
// Needs a real organization account, so it is not unit-tested; see test/commands/sso.test.ts for the rest.
import { authError, errorMessage, generic } from "../core/errors.js";
import { extractToken, type Credentials, type Progress, type Scraper } from "./token.js";

type PW = typeof import("playwright");
type Page = import("playwright").Page;

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CHROMIUM_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-save-password-bubble",
  "--disable-password-manager-reauthentication",
  "--password-store=basic",
  "--disable-blink-features=AutomationControlled",
];
const LOGIN_TIMEOUT_MS = 15_000;
const POLL_MS = 500;
const SUBMIT_FALLBACK_MS = 3000;
const SETTLE_MS = 3000;

const EVASION_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => false });
  window.chrome = { runtime: {}, loadTimes: function () { return {}; }, csi: function () { return {}; }, app: { isInstalled: false } };
  const originalQuery = window.navigator.permissions && window.navigator.permissions.query
    ? window.navigator.permissions.query.bind(window.navigator.permissions) : null;
  if (originalQuery) {
    window.navigator.permissions.query = (parameters) =>
      parameters.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : originalQuery(parameters);
  }
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko', 'en-US', 'en'] });
`;

const visible = (l: import("playwright").Locator, timeout: number) => l.isVisible({ timeout }).catch(() => false);

async function loadPlaywright(): Promise<PW> {
  try {
    return await import("playwright");
  } catch {
    throw generic("auth sso needs Playwright: npm install -g playwright && npx playwright install chromium");
  }
}

/** Prefer the installed Google Chrome; fall back to Playwright's Chromium. */
async function launch(pw: PW, headless: boolean) {
  try {
    return await pw.chromium.launch({ channel: "chrome", headless, args: CHROMIUM_ARGS });
  } catch {
    try {
      return await pw.chromium.launch({ headless, args: CHROMIUM_ARGS });
    } catch (e) {
      throw generic(`cannot start a browser (${errorMessage(e)}); run: npx playwright install chromium`);
    }
  }
}

/**
 * Fills the first text field and the password field of the form that has a password field (works for
 * forms like #login_id/#login_pwd and #username/#password alike), submits, and waits to be sent back
 * to the Dooray host.
 */
async function login(page: Page, url: string, creds: Credentials): Promise<boolean> {
  page.on("dialog", (d) => void d.accept().catch(() => undefined));
  await page.addInitScript(EVASION_SCRIPT);
  await page.goto(url, { waitUntil: "networkidle" });
  const form = page.locator("form").filter({ has: page.locator('input[type="password"]') }).first();
  const password = form.locator('input[type="password"]').first();
  if (!(await visible(password, 10_000))) return false;
  await form.locator('input:is([type="text"], [type="email"], :not([type]))').filter({ visible: true }).first().fill(creds.username);
  await password.fill(creds.password);
  await password.press("Enter");
  const host = new URL(url).host;
  const back = () => new URL(page.url()).host === host;
  // ponytail: Enter submits most sign-in forms; pages that only react to a button/link get one click.
  let clicked = false;
  for (const start = Date.now(); Date.now() - start < LOGIN_TIMEOUT_MS; await page.waitForTimeout(POLL_MS)) {
    if (back()) return true;
    if (!clicked && Date.now() - start > SUBMIT_FALLBACK_MS) {
      clicked = true;
      const submit = page.locator('[type="submit"], button:has-text("로그인"), a:has-text("로그인"), button:has-text("Login"), button:has-text("Sign in")');
      await submit.filter({ visible: true }).first().click({ timeout: 2000 }).catch(() => undefined);
    }
  }
  return back();
}

async function apiSettings(page: Page, url: string): Promise<Page> {
  await page.goto(`${url}/setting/api`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(SETTLE_MS); // Dooray SPA never reaches networkidle
  return page;
}

async function deleteToken(settings: Page, name: string): Promise<void> {
  const row = settings.locator(`tr:has-text("${name}")`);
  if (!(await visible(row, 3000))) return;
  await row.locator('button:has-text("삭제")').click({ force: true }).catch(() => undefined);
  await settings.waitForTimeout(1000);
  await settings.locator('[data-testid="ConfirmDialog_ContainedButton"]').click({ force: true, timeout: 5000 }).catch(() => undefined);
  await settings.waitForTimeout(1000);
}

async function createToken(settings: Page, name: string): Promise<string> {
  await settings.locator('[data-testid="SettingDetailCornerButton_ContainedButton"]').click({ force: true, timeout: 10_000 });
  await settings.waitForTimeout(500);
  await settings.locator('[data-testid="CreatePersonalAuthToken_OutlinedTextField"]').fill(name);
  await settings.locator('[data-testid="CreatePersonalAuthToken_ContainedButton"]').click({ force: true });
  await settings.waitForTimeout(2000);
  // The whole result <dl> and its dt/dd all carry this testid; the token is the own text of
  // <div data-testid=…>TOKEN<button>복사하기</button></div>, so pick the one with a direct button child.
  const cell = settings.locator('div[data-testid="CreatePersonalAuthTokenSuccessfully"]:has(> button)');
  await cell.waitFor({ timeout: 10_000 });
  const raw = await cell.evaluate((el) => [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(""));
  const token = extractToken(raw);
  if (!token) throw generic("토큰 텍스트를 추출할 수 없습니다");
  return token;
}

export const scrapeToken: Scraper = async (url: string, creds: Credentials, tokenName: string, progress: Progress) => {
  progress(5, "브라우저 시작 중...");
  const pw = await loadPlaywright();
  const browser = await launch(pw, process.env.DOORAY_SSO_HEADED !== "true");
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: USER_AGENT,
      // Some organizations' sign-in pages use their own CA; ignoring TLS errors is opt-in only.
      ignoreHTTPSErrors: process.env.DOORAY_SSO_INSECURE_TLS === "true",
      locale: "ko-KR",
      extraHTTPHeaders: { "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7" },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    progress(10, "기관 SSO 로그인 중...");
    if (!(await login(page, url, creds))) throw authError("기관 SSO 로그인 실패: 계정 정보를 확인해주세요 (DOORAY_SSO_HEADED=true로 화면을 볼 수 있습니다).");
    progress(50, "Dooray API 설정 페이지 이동 중...");
    const settings = await apiSettings(page, url);
    progress(75, "기존 토큰 정리 중...");
    await deleteToken(settings, tokenName);
    progress(85, "새 토큰 생성 중...");
    const token = await createToken(settings, tokenName);
    progress(100, "토큰 발급 완료");
    return token;
  } finally {
    await browser.close().catch(() => undefined);
  }
};
