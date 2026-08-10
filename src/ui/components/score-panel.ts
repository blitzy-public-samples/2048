// The score and best-score outlets of the in-run HUD: their text, the score
// delta node, and the accessible names they carry.
//
// A component, not a screen. It declares no router lifecycle of its own, and a
// screen calls `update` once per `state:commit`.
//
// The best score arrives as the storage layer returns it — a string where one
// is stored and the number `0` where none is — and reaches the DOM as text. No
// member below converts it, retains it or compares it: js/game_manager.js
// L80-L82 promotes it and its L95 re-reads it after the write.
//
// One traceability row of docs/TRACEABILITY_MATRIX.md apiece, every row of
// this module's area enumerated:
//   TR-SCORE-01  js/html_actuator.js L106-L121  `updateScore` and the rising
//                                               `.score-addition` delta
//   TR-SCORE-02  js/html_actuator.js L123-L125  `updateBestScore`
//   TR-SCORE-03  index.html                     the two outlets, each seeded
//                                               with `0`
//   TR-SCORE-04  style/main.scss                the `Score` and `Best` `:after`
//                                               captions, given a real
//                                               accessible counterpart
//   TR-SCORE-05  js/game_manager.js L80-L82     the best-score value shape,
//                                               carried to the DOM unconverted
//   TR-SCORE-06  js/game_manager.js L95         the best score re-read after
//                                               the write
//   TR-SCORE-07  target-only row                `createScorePanel()`,
//                                               `ScoreSnapshot` and the guarded
//                                               lookups
//
// Decisions: DL-SCORE-01, DL-SCORE-02, DL-SCORE-03 (docs/DECISION_LOG.md).

import type { BestScoreValue } from '../../engine/types';
import type { UiReporter } from '../a11y/settings';
import {
  NOOP_UI_REPORTER,
  createSafeUiReporter,
  resolveMount,
} from '../a11y/settings';

/** Selector of the score outlet. Read at js/html_actuator.js L3. */
const SCORE_SELECTOR = '.score-container';

/** Selector of the best-score outlet. Read at js/html_actuator.js L4. */
const BEST_SELECTOR = '.best-container';

/** Class the delta node carries. Styled at style/main.scss. */
const SCORE_ADDITION_CLASS = 'score-addition';

/** Class that hides a node visually. style/_a11y.scss. */
const VISUALLY_HIDDEN_CLASS = 'visually-hidden';

/** Element the delta node is. js/html_actuator.js L115. */
const ADDITION_TAG = 'div';

/** Element an added accessible name is carried by. */
const LABEL_TAG = 'span';

/** Prefix the delta text carries. js/html_actuator.js L117. */
const DELTA_PREFIX = '+';

/** Accessible name of the score outlet. style/main.scss. */
const SCORE_LABEL = 'Score';

/** Accessible name of the best-score outlet. style/main.scss. */
const BEST_LABEL = 'Best';

/** Logical name of the score mount, carried into every report. */
const SCORE_MOUNT = 'score';

/** Logical name of the best-score mount, carried into every report. */
const BEST_MOUNT = 'best';

/** Label naming this module in every report. */
const REPORT_CONTEXT = 'score-panel';

/** Attribute that names an element directly. */
const LABEL_ATTRIBUTE = 'aria-label';

/** Attribute that names an element by reference. */
const LABELLED_BY_ATTRIBUTE = 'aria-labelledby';

/** Counter raised once per completed mount, carrying each outlet's state. */
const MOUNTED_METRIC = 'ui.scorePanel.mounted';

/** Counter raised once per outlet the document did not supply. */
const MOUNT_MISSING_METRIC = 'ui.scorePanel.mount_missing';

/** Counter raised per write skipped for want of an outlet. */
const WRITE_SKIPPED_METRIC = 'ui.scorePanel.write_skipped';

/** Counter raised per call that reaches a destroyed panel. */
const WRITE_AFTER_DESTROY_METRIC = 'ui.scorePanel.write_after_destroy';

/** Counter raised per accessible name this component created. */
const LABEL_ADDED_METRIC = 'ui.scorePanel.label_added';

/** Counter raised per outlet the markup already names. */
const LABEL_DECLARED_METRIC = 'ui.scorePanel.label_declared';

/** Counter raised per label element adopted from the markup. */
const LABEL_ADOPTED_METRIC = 'ui.scorePanel.label_adopted';

/** Counter raised where no document can create an accessible name. */
const LABEL_UNAVAILABLE_METRIC = 'ui.scorePanel.label_unavailable';

/** Counter raised per delta node appended. */
const DELTA_SHOWN_METRIC = 'ui.scorePanel.delta_shown';

/** Counter raised per delta node the panel could not append. */
const DELTA_SKIPPED_METRIC = 'ui.scorePanel.delta_skipped';

/** Counter raised once per `destroy`. */
const DESTROYED_METRIC = 'ui.scorePanel.destroyed';

/**
 * The two quantities one commit carries to this component: the score half of
 * the actuation payload at js/game_manager.js L91-L97.
 */
export interface ScoreSnapshot {
  /** Score the engine has committed. */
  readonly score: number;

  /**
   * Best score as the storage layer returned it, typed as `BestScoreValue` —
   * the best-score port's OWN return type, aliased rather than restated. The
   * frozen contract is the raw stored string where one is stored and the
   * number `0` where none is.
   */
  readonly bestScore: BestScoreValue;
}

/**
 * Everything the factory accepts. Every member is optional: the component is
 * constructible from a document alone, and from no document at all.
 */
export interface ScorePanelOptions {
  /**
   * Score outlet, already resolved. Used as given, with no lookup of its own.
   */
  readonly scoreContainer?: HTMLElement | null;

  /** Best-score outlet, already resolved. Used as given. */
  readonly bestContainer?: HTMLElement | null;

  /**
   * Document a lookup runs against and a node is created by. Defaults to the
   * ambient document, and to no document outside a browser.
   */
  readonly document?: Document;

  /** Sink every miss and every skipped write is reported through. */
  readonly reporter?: UiReporter;
}

/** The score and best-score outlets, as one mounted component. */
export interface ScorePanel {
  /**
   * Writes both quantities: the score first, then the best score, which is the
   * order of js/html_actuator.js L24-L25.
   *
   * @param snapshot Score and best score of one commit.
   */
  update(snapshot: ScoreSnapshot): void;

  /**
   * Writes the score and, where it rose, the delta.
   *
   * @param score Score to show.
   */
  updateScore(score: number): void;

  /**
   * Writes the best score.
   *
   * @param bestScore Best score to show, exactly as it arrives.
   */
  updateBestScore(bestScore: BestScoreValue): void;

  /**
   * Whether both outlets resolved.
   *
   * @returns `true` only where the score outlet and the best-score outlet
   *   are both present.
   */
  isReady(): boolean;

  /**
   * Detaches the nodes this component created and releases both outlets. Every
   * later call is a reported no-op.
   */
  destroy(): void;
}

/** One outlet, the accessible name it carries, and who owns that name. */
interface Surface {
  /** The outlet, or `null` where the document did not supply one. */
  element: HTMLElement | null;

  /**
   * Node re-inserted ahead of the value on every write, or `null` where the
   * markup already names the outlet.
   */
  label: Element | null;

  /** Whether this component created `label`. */
  ownsLabel: boolean;

  /** Selector the outlet resolves by. */
  readonly selector: string;

  /** Logical name carried into every report. */
  readonly name: string;
}

/**
 * Reads the ambient document.
 *
 * @returns The document, or `null` outside a browser.
 */
function readAmbientDocument(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

/**
 * Resolves the document a node is created by.
 *
 * @param element Outlet the node is created for, or `null`.
 * @param supplied Document the caller injected, or `null`.
 * @returns The injected document, the outlet's own document, or `null`.
 */
function documentFor(
  element: Element | null,
  supplied: Document | null,
): Document | null {
  if (supplied !== null) {
    return supplied;
  }

  if (element === null) {
    return null;
  }

  return element.ownerDocument;
}

/**
 * Reads an attribute and trims it.
 *
 * @param element Element to read.
 * @param name Attribute name.
 * @returns The trimmed value, or an empty string where the attribute is
 *   absent.
 */
function trimmedAttribute(element: Element, name: string): string {
  const value = element.getAttribute(name);

  return value === null ? '' : value.trim();
}

/**
 * Whether the markup already names an outlet.
 *
 * @param element Outlet to test.
 * @returns Whether either labelling attribute carries a value.
 */
function hasDeclaredName(element: Element): boolean {
  return (
    trimmedAttribute(element, LABEL_ATTRIBUTE).length > 0 ||
    trimmedAttribute(element, LABELLED_BY_ATTRIBUTE).length > 0
  );
}

/**
 * Finds a label the markup already placed inside an outlet: the first element
 * child carrying style/_a11y.scss's visually-hidden class.
 *
 * @param element Outlet to search.
 * @returns The label element, or `null`.
 */
function findDeclaredLabel(element: Element): Element | null {
  const children = element.children;

  for (let index = 0; index < children.length; index += 1) {
    const child = children.item(index);

    if (child !== null && child.classList.contains(VISUALLY_HIDDEN_CLASS)) {
      return child;
    }
  }

  return null;
}

/**
 * Removes every child of an element.
 *
 * @param element Element to empty.
 */
function clearElement(element: Element): void {
  while (element.firstChild !== null) {
    element.removeChild(element.firstChild);
  }
}

/**
 * Empties an outlet, where there is one.
 *
 * @param surface Outlet to empty.
 */
function clearSurface(surface: Surface): void {
  if (surface.element !== null) {
    clearElement(surface.element);
  }
}

/**
 * Writes an outlet's value: the accessible name first, then the value as one
 * text node.
 *
 * @param surface Outlet to write.
 * @param text Value to show.
 * @param reporter Contained sink.
 */
function writeSurfaceValue(
  surface: Surface,
  text: string,
  reporter: UiReporter,
): void {
  const element = surface.element;

  if (element === null) {
    reporter.count(WRITE_SKIPPED_METRIC, {
      mount: surface.name,
      selector: surface.selector,
    });

    return;
  }

  if (surface.label !== null) {
    element.appendChild(surface.label);
  }

  element.append(text);
}

/**
 * Detaches a node from its parent, where it has one.
 *
 * @param node Node to detach, or `null`.
 */
function detach(node: Node | null): void {
  if (node === null) {
    return;
  }

  const parent = node.parentNode;

  if (parent !== null) {
    parent.removeChild(node);
  }
}

/**
 * Releases an outlet's accessible name, detaching it only where this component
 * created it.
 *
 * @param surface Outlet to release.
 */
function releaseLabel(surface: Surface): void {
  if (surface.ownsLabel) {
    detach(surface.label);
  }

  surface.label = null;
  surface.ownsLabel = false;
}

/**
 * Resolves one outlet without asserting and without throwing.
 *
 * @param injected Element the caller injected, `null` for one the caller
 *   looked for and did not find, or `undefined` for none supplied.
 * @param selector Selector the outlet resolves by.
 * @param name Logical name carried into every report.
 * @param owner Document the lookup runs against, or `null`.
 * @param reporter Contained sink.
 * @returns The outlet, or `null`.
 */
function resolveSurfaceElement(
  injected: HTMLElement | null | undefined,
  selector: string,
  name: string,
  owner: Document | null,
  reporter: UiReporter,
): HTMLElement | null {
  if (injected !== undefined) {
    return injected;
  }

  return resolveMount<HTMLElement>(selector, {
    root: owner,
    reporter,
    context: REPORT_CONTEXT,
    name,
  });
}

/**
 * Resolves the accessible name an outlet carries.
 *
 * @param surface Outlet to name.
 * @param labelText Word the name carries.
 * @param owner Document a name is created by, or `null`.
 * @param reporter Contained sink.
 */
function prepareLabel(
  surface: Surface,
  labelText: string,
  owner: Document | null,
  reporter: UiReporter,
): void {
  const element = surface.element;

  if (element === null) {
    return;
  }

  const declared = findDeclaredLabel(element);

  if (declared !== null) {
    surface.label = declared;
    surface.ownsLabel = false;
    reporter.count(LABEL_ADOPTED_METRIC, { mount: surface.name });

    return;
  }

  if (hasDeclaredName(element)) {
    reporter.count(LABEL_DECLARED_METRIC, { mount: surface.name });

    return;
  }

  const ownerDocument = documentFor(element, owner);

  if (ownerDocument === null) {
    reporter.log(
      'warn',
      `The ${surface.name} outlet ${surface.selector} has no document to ` +
        'take an accessible name from.',
      { mount: surface.name, selector: surface.selector },
    );
    reporter.count(LABEL_UNAVAILABLE_METRIC, { mount: surface.name });

    return;
  }

  const label = ownerDocument.createElement(LABEL_TAG);

  label.classList.add(VISUALLY_HIDDEN_CLASS);
  label.textContent = labelText;

  surface.label = label;
  surface.ownsLabel = true;

  reporter.count(LABEL_ADDED_METRIC, {
    mount: surface.name,
    label: labelText,
  });
}

/**
 * Resolves one outlet and its accessible name, reporting whichever it did not
 * obtain.
 *
 * @param injected Element the caller injected, if any.
 * @param selector Selector the outlet resolves by.
 * @param name Logical name carried into every report.
 * @param labelText Word the accessible name carries.
 * @param owner Document the lookup runs against, or `null`.
 * @param reporter Contained sink.
 * @returns The outlet's state, whether or not it resolved.
 */
function mountSurface(
  injected: HTMLElement | null | undefined,
  selector: string,
  name: string,
  labelText: string,
  owner: Document | null,
  reporter: UiReporter,
): Surface {
  const surface: Surface = {
    element: resolveSurfaceElement(injected, selector, name, owner, reporter),
    label: null,
    ownsLabel: false,
    selector,
    name,
  };

  if (surface.element === null) {
    reporter.log('warn', `The ${name} outlet ${selector} is absent.`, {
      mount: name,
      selector,
      context: REPORT_CONTEXT,
      injected: injected !== undefined,
    });
    reporter.count(MOUNT_MISSING_METRIC, { mount: name, selector });

    return surface;
  }

  prepareLabel(surface, labelText, owner, reporter);

  return surface;
}


/**
 * Mounts the score and best-score outlets.
 *
 * Nothing is read or written at import time: the two lookups, the two
 * accessible names and every report happen inside this call. An outlet the
 * document does not supply is reported and its writes are skipped; the other
 * outlet is unaffected and keeps working.
 *
 * @param options Pre-resolved outlets, document and report sink. Every
 *   member is optional.
 * @returns The mounted panel, whether or not both outlets resolved.
 */
export function createScorePanel(
  options: ScorePanelOptions = {},
): ScorePanel {
  const reporter = createSafeUiReporter(options.reporter ?? NOOP_UI_REPORTER);
  const owner = options.document ?? readAmbientDocument();

  const scoreSurface = mountSurface(
    options.scoreContainer,
    SCORE_SELECTOR,
    SCORE_MOUNT,
    SCORE_LABEL,
    owner,
    reporter,
  );
  const bestSurface = mountSurface(
    options.bestContainer,
    BEST_SELECTOR,
    BEST_MOUNT,
    BEST_LABEL,
    owner,
    reporter,
  );

  // js/html_actuator.js L7: the previous-score field starts at `0`.
  let previousScore = 0;

  // The delta node currently attached, held for `destroy`.
  let delta: Element | null = null;

  let destroyed = false;

  /**
   * Records a call that reached a destroyed panel.
   *
   * @param method Name of the member called.
   */
  const reportAfterDestroy = (method: string): void => {
    reporter.log('debug', 'A call reached a destroyed score panel.', {
      method,
      context: REPORT_CONTEXT,
    });
    reporter.count(WRITE_AFTER_DESTROY_METRIC, {
      method,
      context: REPORT_CONTEXT,
    });
  };

  /**
   * Appends the delta node inside the score outlet.
   *
   * Ported from js/html_actuator.js L115-L119. `.score-addition` is a
   * descendant rule of `.score-container` at style/main.scss. The node is
   * appended inside the outlet and carries that class alone; every length,
   * colour and duration of the `move-up` animation is declared there.
   *
   * @param difference Amount the score rose by.
   */
  const appendDelta = (difference: number): void => {
    const element = scoreSurface.element;
    const ownerDocument = documentFor(element, owner);

    if (element === null || ownerDocument === null) {
      reporter.count(DELTA_SKIPPED_METRIC, {
        mount: scoreSurface.name,
        selector: scoreSurface.selector,
      });

      return;
    }

    const addition = ownerDocument.createElement(ADDITION_TAG);

    addition.classList.add(SCORE_ADDITION_CLASS);
    addition.textContent = `${DELTA_PREFIX}${difference}`;
    element.appendChild(addition);

    delta = addition;

    reporter.count(DELTA_SHOWN_METRIC, {
      mount: scoreSurface.name,
      difference,
    });
  };

  /**
   * Writes the score and, where it rose, the delta.
   *
   * @param score Score to show.
   */
  const updateScore = (score: number): void => {
    if (destroyed) {
      reportAfterDestroy('updateScore');

      return;
    }

    // L107.
    clearSurface(scoreSurface);

    // That clear removed the delta node of the previous write.
    delta = null;

    // L109.
    const difference = score - previousScore;

    // L110.
    previousScore = score;

    // L112.
    writeSurfaceValue(scoreSurface, String(previousScore), reporter);

    // L114-L120.
    if (difference > 0) {
      appendDelta(difference);
    }
  };

  /**
   * Writes the best score.
   *
   * Ported from js/html_actuator.js L123-L125: the value is written as the
   * outlet's text and nothing else happens. It is not converted, not retained,
   * not compared and not formatted.
   *
   * @param bestScore Best score to show, exactly as it arrives.
   */
  const updateBestScore = (bestScore: BestScoreValue): void => {
    if (destroyed) {
      reportAfterDestroy('updateBestScore');

      return;
    }

    clearSurface(bestSurface);
    writeSurfaceValue(bestSurface, String(bestScore), reporter);
  };

  /**
   * Writes both quantities of one commit.
   *
   * The order is that of js/html_actuator.js L24-L25: the score, then the best
   * score.
   *
   * @param snapshot Score and best score of one commit.
   */
  const update = (snapshot: ScoreSnapshot): void => {
    if (destroyed) {
      reportAfterDestroy('update');

      return;
    }

    updateScore(snapshot.score);
    updateBestScore(snapshot.bestScore);
  };

  /**
   * Whether both outlets resolved.
   *
   * @returns `true` only where both are present and the panel is live.
   */
  const isReady = (): boolean =>
    scoreSurface.element !== null && bestSurface.element !== null;

  /**
   * Detaches the delta node and every accessible name this component created,
   * releases both outlets, and leaves each outlet's value text in place.
   */
  const destroy = (): void => {
    if (destroyed) {
      reportAfterDestroy('destroy');

      return;
    }

    destroyed = true;

    detach(delta);
    delta = null;

    releaseLabel(scoreSurface);
    releaseLabel(bestSurface);

    scoreSurface.element = null;
    bestSurface.element = null;

    reporter.count(DESTROYED_METRIC, { context: REPORT_CONTEXT });
  };

  reporter.count(MOUNTED_METRIC, {
    context: REPORT_CONTEXT,
    score: scoreSurface.element !== null,
    best: bestSurface.element !== null,
  });

  return Object.freeze({
    update,
    updateScore,
    updateBestScore,
    isReady,
    destroy,
  });
}
