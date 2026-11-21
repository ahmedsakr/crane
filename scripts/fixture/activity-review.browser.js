// Evaluated by `npm run screenshot -- --eval` in the fixture page.
(() => {
  const path = "/_fixture/activity-review";
  const activity = () => widget("#task-activity-body");
  const instruction = () => widget(".task-instruction");
  const rows = () => [...activity().querySelectorAll(".timeline > li")];
  const older = () => document.querySelector('button[aria-controls="task-activity-body"]');
  const latest = () => document.querySelector("#task-activity-body .timeline > li:last-child")?.textContent;
  const gap = () => activity().scrollHeight - activity().clientHeight - activity().scrollTop;

  /** @param {unknown} condition @param {string} description @returns {asserts condition} */
  function expect(condition, description) {
    if (!condition) throw new Error(description);
  }

  /** @param {string} selector */
  function widget(selector) {
    const element = document.querySelector(selector);
    expect(element instanceof HTMLElement, `Missing ${selector}`);
    return element;
  }

  /** @param {() => boolean | undefined} check @param {string} description */
  async function until(check, description) {
    const deadline = performance.now() + 8000;
    while (!check()) {
      expect(performance.now() < deadline, description);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** @param {string} id @param {string} title @param {string} lastEntry */
  async function navigate(id, title, lastEntry) {
    // Exercise the SPA router and keep the same document across task switches.
    history.pushState(null, "", `/tasks/${id}`);
    dispatchEvent(new PopStateEvent("popstate"));
    await until(() => document.querySelector(".detail-title")?.textContent === title && latest()?.includes(lastEntry), `Task did not load: ${title}`);
  }

  /** @param {number} number */
  async function append(number) {
    const response = await fetch(path, { method: "POST", headers: { "X-Crane-Activity-Review": "append" } });
    expect(response.ok, `Fixture append failed (${response.status})`);
    await until(() => latest()?.includes(`Live review entry ${number}`), `Live review entry ${number} did not reach Activity`);
  }

  /** @param {Element} row */
  function offset(row) {
    return row.getBoundingClientRect().top - activity().getBoundingClientRect().top;
  }

  function anchor() {
    const row = rows().find((entry) => offset(entry) + entry.getBoundingClientRect().height > 0);
    expect(row, "No visible activity row to anchor");
    const before = offset(row);
    return (/** @type {string} */ description) => expect(row.isConnected && Math.abs(offset(row) - before) <= 2, description);
  }

  /** @type {{ primary: string, secondary: string } | null} */
  let tasks = null;
  /** @type {{ position: number, page: number } | null} */
  let keyboardStart = null;

  /** @param {HTMLElement} widget */
  function focusWidget(widget) {
    expect(widget.tabIndex === 0 && widget.scrollHeight > widget.clientHeight, "Widget is not focusable and scrollable");
    widget.scrollIntoView({ block: "center" });
    widget.focus({ preventScroll: true });
    keyboardStart = { position: widget.scrollTop, page: scrollY };
  }

  /** @param {HTMLElement} widget @param {number} direction @param {string} name */
  function checkKeyboard(widget, direction, name) {
    expect(keyboardStart, `${name} was never focused for keyboard scrolling`);
    expect(document.activeElement === widget, `${name} lost keyboard focus`);
    expect((widget.scrollTop - keyboardStart.position) * direction > 0, `Keyboard did not scroll ${name}`);
    expect(Math.abs(scrollY - keyboardStart.page) <= 2, `Keyboard scrolled the page while focused in ${name}`);
    return `${name} keyboard scrolling passed`;
  }

  const activityReview = {
    async open() {
      const response = await fetch(path);
      expect(response.ok, `Activity fixture unavailable (${response.status})`);
      const seeded = await response.json();
      tasks = seeded;
      await navigate(seeded.primary, "Long activity history", "entry 180");
      expect(gap() <= 2 && rows().length === 50 && older(), "Activity did not open at the end of the recent batch");
      focusWidget(instruction());
      return "Long activity history opened at the latest entry";
    },
    instructionScrolled() {
      return checkKeyboard(instruction(), 1, "Instruction");
    },
    focusActivity() {
      focusWidget(activity());
    },
    activityScrolled() {
      return checkKeyboard(activity(), -1, "Activity");
    },
    async loadOlder() {
      const checkButtonAnchor = anchor();
      const button = older();
      expect(button instanceof HTMLButtonElement, "Show older entries is unavailable");
      button.click();
      await until(() => rows().length === 100, "Show older entries did not prepend a batch");
      checkButtonAnchor("Show older entries moved the visible row");
      activity().scrollTop = 0;
      const checkScrollAnchor = anchor();
      await until(() => rows().length === 150, "Scrolling to the top did not prepend a batch");
      checkScrollAnchor("Scrolling to the top moved the visible row");
      return "Button and scroll prepends preserved the reading position";
    },
    async checkLive() {
      expect(gap() > 32, "Activity must be away from the bottom to check reading position");
      const checkLiveAnchor = anchor();
      await append(1);
      checkLiveAnchor("A live append moved the reading position away from the bottom");
      activity().scrollTop = activity().scrollHeight - activity().clientHeight - 24;
      expect(gap() > 2 && gap() <= 32, "Activity must be near the bottom to check follow");
      await append(2);
      expect(gap() <= 2, "Activity did not follow a live append from near the bottom");
      return "Live append preserved the reading position and followed from near the bottom";
    },
    async switchTasks() {
      expect(tasks, "The seeded tasks have not been opened");
      const original = activity();
      original.scrollTop = original.scrollHeight / 2;
      await navigate(tasks.secondary, "Second activity history", "entry 024");
      expect(rows().length === 25 && !older() && gap() <= 2, "Second task inherited activity history or scroll position");
      await navigate(tasks.primary, "Long activity history", "Live review entry 2");
      expect(activity() !== original && rows().length === 50 && older() && gap() <= 2, "Returning to the first task did not restore its recent-batch view");
      activity().scrollIntoView({ block: "center" });
      return "Switching away and back opened each task at its own latest entry";
    },
  };
  Object.assign(window, { activityReview });
  return "Activity review checks loaded";
})()
