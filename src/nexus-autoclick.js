'use strict';
// ============================================================================
// Nexus auto-click — the ONE place that knows what the Nexus download page
// looks like. When Nexus changes its page, this is the file to update.
// ============================================================================
//
// What it is for: a FREE Nexus account cannot get a download link from the
// API; the website must start the download. Mod Command X opens the embedded
// Nexus panel (<webview partition="persist:nexus">) straight at the exact
// file's download page
//     https://www.nexusmods.com/{game}/mods/{modId}?tab=files&file_id={fileId}&nmm=1
// and this script presses the buttons the user would press: "Slow download",
// then any follow-up "Mod Manager Download" / nxm:// link the page shows. The
// nxm:// link the site then emits is caught by the main process (main.js,
// web-contents-created → handleNxm), which downloads and installs the file.
//
// House rules — these are deliberate, keep them when editing:
//  - The page stays VISIBLE and untouched: nothing is hidden, stripped or
//    restyled, ads included.
//  - Nexus's own wait is never bypassed or shortened. A button is pressed only
//    when the SITE has made it visible and enabled; a countdown is waited out.
//  - Each kind of button is pressed at most ONCE per page load (the agent's
//    state lives on the page's window, so a reload starts fresh — no loops).
//  - A CAPTCHA / bot check / any challenge iframe stops the automation for
//    that page load. It is never solved, skipped or worked around; the user
//    deals with it and presses the button themselves.
//  - It only ever runs on the exact www.nexusmods.com file page that Mod
//    Command X's own one-click flow opened (isTargetPage), never on anything
//    else the user browses to in the panel.
//  - It can be switched off: Settings → Nexus Mods → "Auto-click Nexus
//    download for free accounts". Off, the panel still opens at the exact file.
//
// How it runs: the renderer (src/app.js) calls
//     webview.executeJavaScript(NexusAutoclick.stepCode(target), true)
// every ~600 ms while the panel shows the target page. Each call is one step:
// it installs the agent on first use, looks at the page once, presses at most
// one button, and returns a report { phase, countdown, clicked } that drives
// the panel's status strip. The agent itself sets no timers. The `true`
// (userGesture) is what a real click would carry, so a site handler that
// opens the nxm:// link behaves exactly as if the user had clicked.
//
// Phases: 'searching' (looking for the button), 'waiting' (the button is there
// but the site has not enabled it yet), 'clicked' (a button was pressed; the
// site's countdown / handoff is running), 'login' (the page wants a signed-in
// account), 'challenge' (bot check present — stopped), 'fallback' (nothing
// usable found in time — stopped; the user clicks).
//
// Everything below the RULES block is generic; the RULES block is the part
// that tracks the site.

(function (root) {
  // --------------------------------------------------------------- RULES
  // Regexes are written as [source, flags] so they survive the trip into the
  // page as JSON.
  const RULES = {
    // The free, rate-limited download on the file's download page.
    slowDownload: {
      selectors: ['#slowDownloadButton', '[data-testid="slow-download"]', '[data-e2e="slow-download"]'],
      text: ['^\\s*slow\\s+download\\b', 'i'],
    },
    // The button on a file row (or the follow-up on the chooser page) that
    // leads to the nxm:// handoff for a mod manager. Only pressed when it is
    // for OUR file (see matchesFile) or it is the only one on the page.
    managerDownload: {
      selectors: ['[data-testid="mod-manager-download"]'],
      text: ['mod\\s+manager\\s+download', 'i'],
    },
    // Never press these, whatever else they say (premium upsells).
    avoidText: ['\\b(fast|premium|upgrade|subscribe|membership)\\b', 'i'],
    // A plain nxm:// link the page shows ("click here if your download does
    // not start") — pressed once when it is for our file.
    nxmLink: 'a[href^="nxm:"]',
    // Anything that can be clicked, in the light DOM and in open shadow roots.
    clickable: 'button, a[href], [role="button"], input[type="button"], input[type="submit"]',
    // "Your download will begin in 5 seconds" style text — read only, to show
    // the countdown in the status strip.
    countdown: [
      ['(?:download|start|begin|ready)[^\\n.]{0,60}?\\b(\\d{1,3})\\s*(?:seconds?|secs?|s)\\b', 'i'],
      ['\\b(\\d{1,3})\\s*(?:seconds?|secs?)\\b[^\\n.]{0,40}?(?:download|start|begin)', 'i'],
      ['\\b(?:wait|in)\\s+(\\d{1,3})\\s*(?:seconds?|secs?)\\b', 'i'],
    ],
    // Bot checks / CAPTCHAs. Any hit stops the automation for this page load.
    challenge: {
      selectors: [
        'iframe[src*="challenges.cloudflare.com"]', 'iframe[src*="turnstile"]',
        'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]', 'iframe[title*="challenge" i]',
        '#challenge-form', '#challenge-stage', '#challenge-error-text', '#cf-challenge-running',
        '.cf-turnstile', '.g-recaptcha', '.h-captcha', '[data-sitekey]',
      ],
      title: ['^\\s*just a moment', 'i'],
      text: ['performing security verification|verify(?:ing)? (?:that )?you are (?:a )?human|checking (?:if the site connection is secure|your browser)', 'i'],
    },
    // The page wants a signed-in account before it offers the download.
    login: {
      text: ['\\b(?:log|sign)\\s*in to download\\b|you (?:need|must|have) to (?:be )?(?:logged|signed) in|please (?:log|sign) in', 'i'],
    },
    // How long a page may show nothing usable (no button, no countdown)
    // before the user is asked to click themselves.
    giveUpMs: 20000,
    // Is this page signed in? (pageState). Measured on the live site: the
    // header of an ANONYMOUS page already carries a profile menu — a guest
    // avatar https://avatars.nexusmods.com/0/100, the name "guest" and a
    // <form action=".../auth/sign_out"> — so none of those may count as signed
    // in. A signed-in page's avatar is avatars.nexusmods.com/<member id>/…
    // (the old "/avatars/" path never matches it) and its logout is a button
    // in that form, not a link.
    account: {
      // Server-rendered page flag in an inline script: `isLoggedIn: false`.
      pageFlag: ['\\bisLoggedIn["\']?\\s*:\\s*(true|false)\\b', ''],
      // The header's account avatar: a member id that is not 0 = signed in.
      avatarSelectors: ['header img.profile-pic', 'header img[alt="Profile image" i]', 'header img[src*="avatars.nexusmods.com"]', 'header img[src*="/avatars/"]', '.user-profile-menu img'],
      avatarId: ['(?:avatars\\.nexusmods\\.com|/avatars)/(?:u/)?(\\d+)(?:/|$)', 'i'],
      // The header's account name ("guest" when signed out).
      nameSelectors: ['.user-profile-menu-username', 'header [data-e2eid="user-name"]', 'header a[href*="/users/"][title]'],
      guestName: ['^\\s*guest\\s*$', 'i'],
      // A visible logout link or button.
      logout: ['^\\s*(?:log|sign)\\s*-?\\s*out\\s*$', 'i'],
      logoutHref: ['(?:sign|log)[-_ ]?out', 'i'],
      // A VISIBLE "Log in" in the header = explicitly signed out.
      loginSelectors: ['a#login', '.nav-games-unauthenticated a', 'header a[href*="/auth/sign_in"]'],
      loginText: ['^\\s*(?:log|sign)\\s*in\\s*$', 'i'],
    },
    // Nexus's own error page ("OOPS! SOMETHING WENT WRONG — You can try
    // refreshing the page, or instead discover some new collections").
    oops: {
      text: ['something went wrong', 'i'],
      also: ['refreshing the page|discover some new collections|try again later', 'i'],
    },
  };

  // ------------------------------------------------------ in-page agent
  // Serialised with Function.prototype.toString and run inside the guest page,
  // so it must be self-contained: no closures over this file.
  function agentStep(R, target) {
    const rx = (p) => new RegExp(p[0], p[1]);
    const now = Date.now();
    let A = window.__mcxAutoclick;
    if (!A || A.key !== target.key) {
      A = window.__mcxAutoclick = {
        key: target.key, phase: 'searching', countdown: null, clicked: [],
        idleSince: now, clickedAt: 0, stopped: false,
      };
    }
    const report = () => ({ phase: A.phase, countdown: A.countdown, clicked: A.clicked.slice() });
    if (A.stopped) return report();

    // querySelectorAll across the document and every OPEN shadow root.
    const deep = (sel) => {
      const out = [];
      const visit = (node) => {
        try { out.push(...node.querySelectorAll(sel)); } catch (_) {}
        const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
        for (let el = walker.nextNode(); el; el = walker.nextNode()) if (el.shadowRoot) visit(el.shadowRoot);
      };
      visit(document);
      return out;
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const enabled = (el) => !(el.disabled || el.hasAttribute('disabled')
      || el.getAttribute('aria-disabled') === 'true'
      || /(^|\s)(is-)?disabled(\s|$)/i.test(el.getAttribute('class') || '')
      || getComputedStyle(el).pointerEvents === 'none');
    const label = (el) => [el.innerText || el.textContent || '', el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '', el.value || ''].join(' ').replace(/\s+/g, ' ').trim();
    const avoid = rx(R.avoidText);
    const fileRx = new RegExp('(?:file_id=|/files/)' + target.fileId + '(?:[^0-9]|$)');
    const matchesFile = (el) => fileRx.test(el.getAttribute('href') || '')
      || fileRx.test(el.getAttribute('data-download-url') || '')
      || (el.getAttribute('data-file-id') || '') === String(target.fileId);
    const pageText = () => {
      let t = document.body ? document.body.innerText || '' : '';
      for (const host of deep('*')) if (host.shadowRoot) t += '\n' + (host.shadowRoot.textContent || '');
      return t;
    };
    const press = (el, kind) => {
      A.clicked.push(kind);
      A.clickedAt = now;
      A.phase = 'clicked';
      try { el.scrollIntoView({ block: 'center' }); } catch (_) {}
      el.click();
    };
    const stop = (phase) => { A.phase = phase; A.stopped = true; A.countdown = null; return report(); };

    // 1. A bot check / CAPTCHA anywhere on the page: hands off, for good.
    const ch = R.challenge;
    if (deep(ch.selectors.join(',')).length || rx(ch.title).test(document.title || '')
      || rx(ch.text).test(document.body ? document.body.innerText || '' : '')) {
      return stop('challenge');
    }

    const text = pageText();
    let secs = null;
    for (const p of R.countdown) {
      const m = rx(p).exec(text);
      if (m) { secs = Number(m[1]); break; }
    }
    A.countdown = secs;

    const clickables = deep(R.clickable).filter((el) => visible(el) && !avoid.test(label(el)));
    const byRule = (rule) => {
      const t = rx(rule.text);
      const hits = new Set(deep(rule.selectors.join(',')).filter(visible));
      for (const el of clickables) if (t.test(label(el))) hits.add(el);
      return [...hits].filter((el) => !avoid.test(label(el)));
    };

    // 2. The site already shows an nxm:// link for our file.
    if (!A.clicked.includes('nxm')) {
      const link = deep(R.nxmLink).find((el) => visible(el) && matchesFile(el) && enabled(el));
      if (link) { press(link, 'nxm'); return report(); }
    }

    // 3. "Slow download" on the file's download page.
    const slow = byRule(R.slowDownload)[0] || null;
    if (slow && !A.clicked.includes('slow')) {
      if (enabled(slow)) { press(slow, 'slow'); return report(); }
      A.phase = 'waiting';          // present, but the site has not enabled it yet
      A.idleSince = now;
      return report();
    }

    // 4. A "Mod Manager Download" for our file (a file row, or the follow-up
    //    button some page versions show after "Slow download").
    if (!A.clicked.includes('manager')) {
      const all = byRule(R.managerDownload);
      const mine = all.filter(matchesFile);
      let pick = mine[0] || (all.length === 1 && !(all[0].getAttribute('href') || '').includes('file_id=') ? all[0] : null);
      // After "Slow download" only a real nxm:// handoff may be pressed — a
      // file-row button would just reload this page and start over.
      if (pick && A.clicked.includes('slow') && !/^nxm:/i.test(pick.getAttribute('href') || '')) pick = null;
      if (pick) {
        if (enabled(pick)) { press(pick, 'manager'); return report(); }
        A.phase = 'waiting';
        A.idleSince = now;
        return report();
      }
    }

    // 5. Nothing to press yet.
    if (A.clicked.length) {
      // Pressed; the site's countdown / handoff is running. Only give up when
      // the countdown is over and nothing arrived for giveUpMs.
      if (secs !== null && secs > 0) A.idleSince = now;
      if (now - Math.max(A.idleSince, A.clickedAt) > R.giveUpMs) return stop('fallback');
      A.phase = 'clicked';
      return report();
    }
    if (target.signedIn !== 'in' && rx(R.login.text).test(text)) { A.phase = 'login'; A.idleSince = now; return report(); }
    if (secs !== null && secs > 0) A.idleSince = now;            // the site says wait
    if (document.readyState !== 'complete') A.idleSince = now;   // page still settling
    if (now - A.idleSince > R.giveUpMs) return stop('fallback');
    A.phase = 'searching';
    return report();
  }

  // ------------------------------------------------------ page state (in-page)
  // Serialised like agentStep: self-contained. Reads the page once and says
  // whether it is signed in, by which signal, the header's account name, and
  // whether it is Nexus's error page. Presses nothing.
  //   { state: 'in' | 'out' | 'unknown', signal, name, oops }
  function pageState(R) {
    const rx = (p) => new RegExp(p[0], p[1]);
    const A = R.account;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      const cs = getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
    };
    const q = (sels) => { const out = []; for (const s of sels) { try { out.push(...document.querySelectorAll(s)); } catch (_) {} } return out; };
    const bodyText = document.body ? document.body.innerText || '' : '';
    const oops = rx(R.oops.text).test(bodyText) && rx(R.oops.also).test(bodyText);

    // 1. The page's own flag (server-rendered, so it cannot be "late").
    let flag = null;
    const flagRx = rx(A.pageFlag);
    for (const sc of document.querySelectorAll('script:not([src])')) {
      const m = flagRx.exec(sc.textContent || '');
      if (m) { flag = m[1] === 'true'; break; }
    }
    // 2. Header account markers.
    const idRx = rx(A.avatarId);
    let avatar = null; // 'member' | 'guest' | null
    for (const img of q(A.avatarSelectors)) {
      const m = idRx.exec(img.getAttribute('src') || '');
      if (!m) continue;
      if (m[1] !== '0') { avatar = 'member'; break; }
      avatar = 'guest';
    }
    let name = '';
    let guest = false;
    for (const el of q(A.nameSelectors)) {
      const t = (el.getAttribute('title') || el.textContent || '').trim();
      if (!t) continue;
      if (rx(A.guestName).test(t)) { guest = true; continue; }
      name = t.slice(0, 60); break;
    }
    const logoutRx = rx(A.logout);
    const logoutHref = rx(A.logoutHref);
    const logout = [...document.querySelectorAll('a[href], button, input[type="submit"]')].some((el) => {
      if (!visible(el)) return false;
      if (el.tagName === 'A' && logoutHref.test(el.getAttribute('href') || '')) return true;
      return logoutRx.test((el.innerText || el.value || '').trim());
    });
    const loginRx = rx(A.loginText);
    const login = q(A.loginSelectors).some((el) => visible(el) && loginRx.test((el.innerText || el.textContent || '').trim()));

    let state = 'unknown';
    let signal = null;
    if (flag === true) { state = 'in'; signal = 'page flag isLoggedIn'; }
    else if (flag === false) { state = 'out'; signal = 'page flag isLoggedIn=false'; }
    else if (avatar === 'member') { state = 'in'; signal = 'account avatar'; }
    else if (name) { state = 'in'; signal = 'account name in header'; }
    else if (guest || avatar === 'guest') { state = 'out'; signal = 'guest profile'; }
    else if (logout) { state = 'in'; signal = 'logout link'; }
    else if (login) { state = 'out'; signal = 'Log in button'; }
    if (state !== 'in') name = '';
    return { state, signal, name, oops };
  }

  // ------------------------------------------------------ renderer API
  // Is `url` the exact file page this one-click run opened? Same origin, same
  // /{game}/mods/{modId} path, same file_id. Anything else — another mod, the
  // mod's description, the login pages — is left alone.
  function isTargetPage(url, targetUrl) {
    try {
      const u = new URL(url);
      const t = new URL(targetUrl);
      if (u.origin !== t.origin) return false;
      if (u.pathname.replace(/\/+$/, '') !== t.pathname.replace(/\/+$/, '')) return false;
      return u.searchParams.get('file_id') === t.searchParams.get('file_id');
    } catch (_) { return false; }
  }

  // The Nexus sign-in pages (where the user goes when the file page asks).
  function isLoginPage(url) {
    return /^https:\/\/users\.nexusmods\.com\//i.test(url || '') || /\/(login|sign_in|auth)\b/i.test((() => {
      try { return new URL(url).pathname; } catch (_) { return ''; }
    })());
  }

  // The sign-in flow itself (form, two-factor, OAuth consent) — where the user
  // is typing and the page's Turnstile check lives. Narrower than isLoginPage:
  // an account page on users.nexusmods.com is not part of it.
  function isSignInFlow(url) {
    let p = '';
    try { p = new URL(url).pathname; } catch (_) { return false; }
    return /\/(auth|login|sign_in|sign_up|register|oauth|two_factor)(\/|$)/i.test(p);
  }

  // A Cloudflare interstitial ("Just a moment..."), judged from the webview's
  // title alone so the renderer can stay out of the page entirely while the
  // user completes the check.
  function isChallengeTitle(title) {
    return new RegExp(RULES.challenge.title[0], RULES.challenge.title[1]).test(title || '');
  }

  // target = { modId, fileId, signedIn? } — signedIn: 'in' when the panel
  // already knows this session is signed in; the page's "log in to download"
  // wording is then not taken as a request to sign in.
  function stepCode(target) {
    const t = { modId: Number(target.modId), fileId: Number(target.fileId), key: `${target.modId}:${target.fileId}`, signedIn: target.signedIn || null };
    return `(${agentStep.toString()})(${JSON.stringify(RULES)}, ${JSON.stringify(t)})`;
  }

  function pageStateCode() {
    return `(${pageState.toString()})(${JSON.stringify(RULES)})`;
  }

  // The panel's answer to "signed in?": the page (pageState) and the
  // session's auth cookie NAME from the main process (lib/nexus-panel.js).
  // The page decides when it says so either way — it is what Nexus serves to
  // this session right now; the cookie fills in when the page says neither.
  function combineSignedIn(page, cookie) {
    const p = page || { state: 'unknown' };
    if (p.state === 'in') return { state: 'in', signal: `${p.signal}${cookie ? ` + cookie ${cookie}` : ''}` };
    if (p.state === 'out') return { state: 'out', signal: `${p.signal}${cookie ? ` (cookie ${cookie} present, but the page is signed out)` : ''}` };
    if (cookie) return { state: 'in', signal: `cookie ${cookie}` };
    return { state: 'unknown', signal: null };
  }

  // Nexus's "Something went wrong" page, judged from text alone (tests).
  function isOopsText(text) {
    return new RegExp(RULES.oops.text[0], RULES.oops.text[1]).test(text || '')
      && new RegExp(RULES.oops.also[0], RULES.oops.also[1]).test(text || '');
  }

  // The sign-in page with Nexus's own redirect back to `target` — the same
  // redirect_url its "Log in" links carry.
  function signInUrl(target) {
    const base = 'https://users.nexusmods.com/auth/sign_in';
    return /^https:\/\/([a-z0-9-]+\.)?nexusmods\.com\//i.test(target || '') ? `${base}?redirect_url=${encodeURIComponent(target)}` : base;
  }

  root.NexusAutoclick = {
    RULES, isTargetPage, isLoginPage, isSignInFlow, isChallengeTitle, stepCode, agentStep,
    pageState, pageStateCode, combineSignedIn, isOopsText, signInUrl,
  };
})(typeof window !== 'undefined' ? window : globalThis);
