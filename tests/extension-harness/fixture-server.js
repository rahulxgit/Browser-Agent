// A real HTTP server, not a data:/about:blank page, because Phase 9's
// submission verification checks a real URL change + real page body text
// after a real navigation - none of that exists meaningfully without an
// actual server to navigate between. Deliberately tiny: no framework, no
// dependencies beyond Node's built-in http module.
const http = require("http");

const PAGES = {
  "/apply": `<!doctype html>
<html><body>
  <form id="application">
    <label for="fname">First name</label>
    <input id="fname" name="firstName" type="text" required />
    <label for="lname">Last name</label>
    <input id="lname" name="lastName" type="text" required />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <button type="button" id="submitBtn">Submit Application</button>
  </form>
  <script>
    // A real ATS-style submit: navigates to a real confirmation page
    // rather than just toggling some DOM state in place, so
    // getSubmissionOutcome()'s urlChanged/successPhraseMatched checks
    // have something real to detect.
    document.getElementById("submitBtn").addEventListener("click", () => {
      window.location.href = "/apply/success";
    });
  </script>
</body></html>`,
  "/apply/success": `<!doctype html>
<html><body><h1>Thank you for applying!</h1><p>Your application has been submitted.</p></body></html>`,
  "/apply/error": `<!doctype html>
<html><body><h1>Something went wrong</h1><p>Please try again.</p></body></html>`,
  // Phase 24 live-verification fixture: firstName starts PRE-FILLED (so
  // the deterministic snapshot marks it filled:true from round 0), while
  // "country" is a required, genuinely empty <select>. A stubbed LLM that
  // wrongly claims {"type":"done"} on round 0 - exactly the failure mode
  // from the real user log ("No interactive elements found... ") - must
  // be caught by runTaskInner's hasFillableWork() cross-check against
  // THIS real DOM, not a simulated one.
  "/false-done": `<!doctype html>
<html><body>
  <form id="application">
    <label for="fname">First name</label>
    <input id="fname" name="firstName" type="text" required value="Prefilled" />
    <label for="country">Country</label>
    <select id="country" name="country" required>
      <option value="">Select...</option>
      <option value="IN">India</option>
      <option value="US">United States</option>
    </select>
  </form>
</body></html>`,
  // Cross-origin iframe fixture (see cross-origin-iframe.spec.js): the
  // parent page itself has no fillable fields at all - the entire
  // application form lives inside an <iframe> whose src is injected at
  // request time via a query param pointing at a SECOND fixture server on
  // a different port. Two different ports on the same host still count
  // as two different origins to the browser, which is what makes this a
  // genuine cross-origin test rather than an accidental same-origin one.
  "/parent-with-iframe": (query) => `<!doctype html>
<html><body>
  <h1>Careers Portal</h1>
  <iframe id="appFrame" src="${query.iframeSrc}" style="width:600px;height:400px;border:1px solid #ccc"></iframe>
</body></html>`,
  "/iframe-apply": `<!doctype html>
<html><body>
  <form id="application">
    <label for="fname">First name</label>
    <input id="fname" name="firstName" type="text" required />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required />
    <button type="button" id="submitBtn">Submit Application</button>
  </form>
  <script>
    document.getElementById("submitBtn").addEventListener("click", () => {
      document.body.innerHTML = "<h1>Thank you for applying!</h1><p>Your application has been submitted.</p>";
    });
  </script>
</body></html>`
};

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const [path, rawQuery] = req.url.split("?");
      const query = Object.fromEntries(new URLSearchParams(rawQuery || ""));
      const entry = PAGES[path];
      const body = typeof entry === "function" ? entry(query) : entry;
      res.writeHead(body ? 200 : 404, { "Content-Type": "text/html" });
      res.end(body || "Not found");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

module.exports = { startFixtureServer };
