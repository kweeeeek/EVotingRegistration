# Testing the tests

A test that can never fail proves nothing. These scripts break the page on purpose - one promise at a time, in a **copy** of this folder - and run the tests that should notice.
Nothing in this folder is changed. What the results were, and what they mean: `../../docs/WEB-VERIFICATION.md` §3.

| Command | What it does | Time |
|---|---|---|
| `node tests/mutation/run-mutations.mjs --list` | lists the breakages (`mutations.mjs`) | - |
| `node tests/mutation/run-mutations.mjs [--only M05,M12]` | breaks the page, runs the unit tests and, where the entry names them, the browser tests | about 20 minutes for all |
| `node tests/mutation/run-nginx-mutations.mjs [D02,D10]` | breaks the nginx example, runs `tests/deploy/check-nginx.mjs` | about 3 minutes (needs nginx) |

**CAUGHT** is good: a test failed. **SURVIVED** is a hole in the tests, or a change that no test could ever see (one is known: M25, explained in `WEB-VERIFICATION.md`). **ERROR** means the text to change was not found - the code has changed since the
list was written; update the entry. Run it after changing the page's code or tests: a breakage that used to be caught and now survives shows what the change took away.

It is not part of `npm test`: it takes long and starts many browsers.
