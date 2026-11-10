// A module script keeps pending imports alive while Chromium records a trace.
// Awaiting import() in page.evaluate can fail with CDP "Promise was collected".
export async function runBrowserModule(page, setup, args) {
  await page.addScriptTag({
    type: 'module',
    content: `await (${setup.toString()})(${JSON.stringify(args)});`,
  });
}
