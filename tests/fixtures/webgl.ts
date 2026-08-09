// A WebGL 2 context and a canvas, mocked far enough that Three.js runs.
//
// Decisions: DL-WEBGL-01 (docs/DECISION_LOG.md).

/** The one method of a context this fixture is asked for. */
export type MockContextKind = 'webgl2' | 'webgl';

/** A mocked context, and the constants it has issued. */
export interface MockWebGLContext {
  /** The context itself, as `getContext` returns it. */
  readonly gl: Record<string, unknown>;

  /** The name of one constant this context issued, or `undefined`. */
  readonly nameOf: (code: number) => string | undefined;

  /** Every method name the context was asked for, in first-call order. */
  readonly calls: readonly string[];
}

/**
 * Builds a WebGL 2 context mock.
 *
 * @returns The context and the two read-back helpers.
 * @example
 * ```ts
 * const { gl } = createMockWebGLContext();
 * const canvas = createMockCanvas({ context: gl });
 * ```
 */
export function createMockWebGLContext(): MockWebGLContext {
  const constants = new Map<number, string>();
  const calls: string[] = [];
  const base: Record<string, unknown> = {};
  let nextCode = 1;

  const isConstantName = (name: string): boolean =>
    /^[A-Z][A-Z0-9_]*$/.test(name);

  const nameOf = (code: number): string | undefined => constants.get(code);

  // Only these four are inspected by Three.js.
  const getParameter = (name: number): unknown => {
    const key = nameOf(name);

    switch (key) {
      case 'VERSION':
        return 'WebGL 2.0 (Mock)';
      case 'SHADING_LANGUAGE_VERSION':
        return 'WebGL GLSL ES 3.00 (Mock)';
      case 'RENDERER':
      case 'VENDOR':
        return 'Mock';
      case 'MAX_VIEWPORT_DIMS':
      case 'SCISSOR_BOX':
      case 'VIEWPORT':
        return new Int32Array([0, 0, 4096, 4096]);
      default:
        return 32;
    }
  };

  // A linked program with no uniforms and no attributes.
  const getProgramParameter = (_program: unknown, name: number): unknown => {
    const key = nameOf(name);

    return key === 'ACTIVE_UNIFORMS' || key === 'ACTIVE_ATTRIBUTES' ? 0 : 1;
  };

  const explicit: Record<string, unknown> = {
    getParameter,
    getProgramParameter,
    getShaderParameter: (): unknown => 1,
    getShaderPrecisionFormat: (): unknown => ({
      precision: 23,
      rangeMin: 127,
      rangeMax: 127,
    }),
    getExtension: (): unknown => null,
    getContextAttributes: (): unknown => ({ alpha: false, antialias: true }),
    getProgramInfoLog: (): string => '',
    getShaderInfoLog: (): string => '',
    getError: (): number => 0,
    getAttribLocation: (): number => 0,
    getUniformLocation: (): unknown => ({}),
    createProgram: (): unknown => ({}),
    createShader: (): unknown => ({}),
    createBuffer: (): unknown => ({}),
    createVertexArray: (): unknown => ({}),
    createTexture: (): unknown => ({}),
    createFramebuffer: (): unknown => ({}),
    createRenderbuffer: (): unknown => ({}),
    isContextLost: (): boolean => false,
  };

  const gl = new Proxy(base, {
    has: (): boolean => true,

    get(target, property): unknown {
      if (typeof property !== 'string') {
        return undefined;
      }

      const held = target[property];

      if (held !== undefined) {
        return held;
      }

      const supplied = explicit[property];

      if (supplied !== undefined) {
        calls.push(property);
        target[property] = supplied;

        return supplied;
      }

      if (isConstantName(property)) {
        const code = nextCode;

        nextCode += 1;
        constants.set(code, property);
        target[property] = code;

        return code;
      }

      calls.push(property);

      const method = (): unknown => null;

      target[property] = method;

      return method;
    },
  });

  return Object.freeze({ gl, nameOf, calls });
}

/** Construction parameters for the canvas stand-in. */
export interface MockCanvasOptions {
  /** The context `getContext` returns. `null` refuses every request. */
  readonly context?: unknown;

  /** Measured width, in px. Defaults to the desktop field width. */
  readonly clientWidth?: number;

  /** Measured height, in px. Defaults to the desktop field width. */
  readonly clientHeight?: number;

  /** Document the element is created in, when one is available. */
  readonly document?: Document;
}

/** A canvas stand-in, and what was asked of it. */
export interface MockCanvas {
  /** The element, as `createThreeRenderer` accepts it. */
  readonly element: HTMLCanvasElement;

  /** The `contextType` of every `getContext` call, in order. */
  readonly requests: readonly string[];

  /** Fires one event on the element's listeners for that type. */
  readonly emit: (type: string, event?: Event) => void;
}

/** The field width of the desktop scale, which is the default canvas size. */
const DEFAULT_CANVAS_EXTENT = 500;

/**
 * Builds a canvas stand-in whose `getContext` answers with a mocked context.
 *
 * @param options Context, measured size and owning document.
 * @returns The element and its call log.
 */
export function createMockCanvas(
  options: MockCanvasOptions = {},
): MockCanvas {
  const requests: string[] = [];
  const listeners = new Map<string, Set<EventListener>>();
  const width = options.clientWidth ?? DEFAULT_CANVAS_EXTENT;
  const height = options.clientHeight ?? DEFAULT_CANVAS_EXTENT;
  const owner =
    options.document ?? (typeof document === 'undefined' ? null : document);

  const getContext = (contextType: string): unknown => {
    requests.push(contextType);

    return options.context ?? null;
  };

  const emit = (type: string, event?: Event): void => {
    const bound = listeners.get(type);

    if (bound === undefined) {
      return;
    }

    const resolved =
      event ??
      ({
        type,
        preventDefault: (): void => {},
      } as unknown as Event);

    for (const listener of [...bound]) {
      listener(resolved);
    }
  };

  if (owner !== null) {
    const element = owner.createElement('canvas');

    Object.defineProperty(element, 'getContext', {
      configurable: true,
      value: getContext,
    });
    Object.defineProperty(element, 'clientWidth', {
      configurable: true,
      get: (): number => width,
    });
    Object.defineProperty(element, 'clientHeight', {
      configurable: true,
      get: (): number => height,
    });

    const nativeAdd = element.addEventListener.bind(element);
    const nativeRemove = element.removeEventListener.bind(element);

    Object.defineProperty(element, 'addEventListener', {
      configurable: true,
      value: (type: string, listener: EventListener): void => {
        const bound = listeners.get(type) ?? new Set<EventListener>();

        bound.add(listener);
        listeners.set(type, bound);
        nativeAdd(type, listener);
      },
    });
    Object.defineProperty(element, 'removeEventListener', {
      configurable: true,
      value: (type: string, listener: EventListener): void => {
        listeners.get(type)?.delete(listener);
        nativeRemove(type, listener);
      },
    });

    return Object.freeze({ element, requests, emit });
  }

  // No document at all: a plain object carrying the members the renderer and
  // Three.js read.
  const element = {
    width,
    height,
    clientWidth: width,
    clientHeight: height,
    style: {},
    hidden: false,
    getContext,

    addEventListener: (type: string, listener: EventListener): void => {
      const bound = listeners.get(type) ?? new Set<EventListener>();

      bound.add(listener);
      listeners.set(type, bound);
    },

    removeEventListener: (type: string, listener: EventListener): void => {
      listeners.get(type)?.delete(listener);
    },
  } as unknown as HTMLCanvasElement;

  return Object.freeze({ element, requests, emit });
}
