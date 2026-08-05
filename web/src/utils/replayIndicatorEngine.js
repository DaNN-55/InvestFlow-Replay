const BAR_FIELDS = new Set([
  "open",
  "high",
  "low",
  "close",
  "volume",
  "amount",
]);
const WINDOW_FUNCTIONS = new Set(["REF", "MA", "EMA", "MAX", "MIN"]);
const MAX_EXPRESSION_LENGTH = 500;
const MAX_EXPRESSION_DEPTH = 32;
const MAX_PERIOD = 10000;

export class ReplayIndicatorExpressionError extends Error {
  constructor(message, position = null) {
    super(position === null ? message : `${message}（位置 ${position + 1}）`);
    this.name = "ReplayIndicatorExpressionError";
    this.position = position;
  }
}

function tokenize(expression) {
  const tokens = [];
  let cursor = 0;

  while (cursor < expression.length) {
    const character = expression[cursor];
    if (/\s/u.test(character)) {
      cursor += 1;
      continue;
    }

    if ("+-*/(),".includes(character)) {
      tokens.push({
        type: character,
        value: character,
        position: cursor,
      });
      cursor += 1;
      continue;
    }

    const numberMatch = expression
      .slice(cursor)
      .match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/u);
    if (numberMatch) {
      const value = Number(numberMatch[0]);
      if (!Number.isFinite(value)) {
        throw new ReplayIndicatorExpressionError("数值超出有效范围", cursor);
      }
      tokens.push({
        type: "number",
        value,
        position: cursor,
      });
      cursor += numberMatch[0].length;
      continue;
    }

    const identifierMatch = expression
      .slice(cursor)
      .match(/^[A-Za-z_][A-Za-z0-9_]*/u);
    if (identifierMatch) {
      tokens.push({
        type: "identifier",
        value: identifierMatch[0],
        position: cursor,
      });
      cursor += identifierMatch[0].length;
      continue;
    }

    throw new ReplayIndicatorExpressionError(
      `不支持字符“${character}”`,
      cursor,
    );
  }

  tokens.push({
    type: "eof",
    value: "",
    position: expression.length,
  });
  return tokens;
}

class ExpressionParser {
  constructor(tokens) {
    this.tokens = tokens;
    this.cursor = 0;
    this.depth = 0;
  }

  current() {
    return this.tokens[this.cursor];
  }

  consume(type, message) {
    const token = this.current();
    if (token.type !== type) {
      throw new ReplayIndicatorExpressionError(message, token.position);
    }
    this.cursor += 1;
    return token;
  }

  parse() {
    const expression = this.parseAdditive();
    if (this.current().type !== "eof") {
      throw new ReplayIndicatorExpressionError(
        "表达式末尾存在多余内容",
        this.current().position,
      );
    }
    return expression;
  }

  parseAdditive() {
    let left = this.parseMultiplicative();
    while (this.current().type === "+" || this.current().type === "-") {
      const operator = this.current().type;
      this.cursor += 1;
      left = {
        type: "binary",
        operator,
        left,
        right: this.parseMultiplicative(),
      };
    }
    return left;
  }

  parseMultiplicative() {
    let left = this.parseUnary();
    while (this.current().type === "*" || this.current().type === "/") {
      const operator = this.current().type;
      this.cursor += 1;
      left = {
        type: "binary",
        operator,
        left,
        right: this.parseUnary(),
      };
    }
    return left;
  }

  parseUnary() {
    if (this.current().type === "+" || this.current().type === "-") {
      const operator = this.current().type;
      this.cursor += 1;
      return {
        type: "unary",
        operator,
        argument: this.parseUnary(),
      };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.current();
    if (token.type === "number") {
      this.cursor += 1;
      return {
        type: "number",
        value: token.value,
      };
    }

    if (token.type === "identifier") {
      return this.parseIdentifier();
    }

    if (token.type === "(") {
      this.enterNested(token.position);
      this.cursor += 1;
      const expression = this.parseAdditive();
      this.consume(")", "缺少右括号");
      this.depth -= 1;
      return expression;
    }

    throw new ReplayIndicatorExpressionError(
      "这里需要行情字段、数值或函数",
      token.position,
    );
  }

  parseIdentifier() {
    const token = this.consume("identifier", "缺少名称");
    const fieldName = token.value.toLowerCase();
    if (this.current().type !== "(") {
      if (!BAR_FIELDS.has(fieldName)) {
        throw new ReplayIndicatorExpressionError(
          `不支持字段“${token.value}”`,
          token.position,
        );
      }
      return {
        type: "field",
        name: fieldName,
      };
    }

    const functionName = token.value.toUpperCase();
    if (!WINDOW_FUNCTIONS.has(functionName)) {
      throw new ReplayIndicatorExpressionError(
        `不支持函数“${token.value}”`,
        token.position,
      );
    }

    this.enterNested(token.position);
    this.cursor += 1;
    const source = this.parseAdditive();
    this.consume(",", `${functionName} 需要两个参数`);
    const periodToken = this.consume(
      "number",
      `${functionName} 的周期必须是正整数`,
    );
    if (
      !Number.isInteger(periodToken.value) ||
      periodToken.value < 1 ||
      periodToken.value > MAX_PERIOD
    ) {
      throw new ReplayIndicatorExpressionError(
        `${functionName} 的周期必须是 1-${MAX_PERIOD} 的整数`,
        periodToken.position,
      );
    }
    this.consume(")", `${functionName} 缺少右括号`);
    this.depth -= 1;
    return {
      type: "function",
      name: functionName,
      source,
      period: periodToken.value,
    };
  }

  enterNested(position) {
    this.depth += 1;
    if (this.depth > MAX_EXPRESSION_DEPTH) {
      throw new ReplayIndicatorExpressionError("表达式嵌套层级过深", position);
    }
  }
}

export function parseReplayIndicatorExpression(expression) {
  if (typeof expression !== "string" || !expression.trim()) {
    throw new ReplayIndicatorExpressionError("请输入指标表达式");
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    throw new ReplayIndicatorExpressionError(
      `表达式不能超过 ${MAX_EXPRESSION_LENGTH} 个字符`,
    );
  }
  return new ExpressionParser(tokenize(expression)).parse();
}

export function validateReplayIndicatorExpression(expression) {
  try {
    parseReplayIndicatorExpression(expression);
    return {
      valid: true,
      error: null,
    };
  } catch (error) {
    return {
      valid: false,
      error:
        error instanceof ReplayIndicatorExpressionError
          ? error.message
          : "指标表达式无法解析",
    };
  }
}

function toFiniteValue(value) {
  if (
    value === null ||
    value === undefined ||
    typeof value === "boolean" ||
    (typeof value === "string" && !value.trim())
  ) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function createConstantSeries(length, value) {
  return Array.from({ length }, () => value);
}

function calculateWindowSeries(source, period, reducer) {
  return source.map((_, index) => {
    const start = index - period + 1;
    if (start < 0) {
      return null;
    }
    const window = source.slice(start, index + 1);
    if (window.some((value) => value === null)) {
      return null;
    }
    return toFiniteValue(reducer(window));
  });
}

function calculateEmaSeries(source, period) {
  const multiplier = 2 / (period + 1);
  let previous = null;
  return source.map((value) => {
    if (value === null) {
      return null;
    }
    const next =
      previous === null ? value : value * multiplier + previous * (1 - multiplier);
    if (!Number.isFinite(next)) {
      return null;
    }
    previous = next;
    return next;
  });
}

function applyBinaryOperator(operator, left, right) {
  if (left === null || right === null) {
    return null;
  }
  let result;
  if (operator === "+") {
    result = left + right;
  } else if (operator === "-") {
    result = left - right;
  } else if (operator === "*") {
    result = left * right;
  } else if (right === 0) {
    return null;
  } else {
    result = left / right;
  }
  return Number.isFinite(result) ? result : null;
}

function evaluateAst(node, bars, cache) {
  if (cache.has(node)) {
    return cache.get(node);
  }

  let values;
  if (node.type === "number") {
    values = createConstantSeries(bars.length, node.value);
  } else if (node.type === "field") {
    values = bars.map((bar) => toFiniteValue(bar?.[node.name]));
  } else if (node.type === "unary") {
    const source = evaluateAst(node.argument, bars, cache);
    values = source.map((value) => {
      if (value === null) {
        return null;
      }
      return node.operator === "-" ? -value : value;
    });
  } else if (node.type === "binary") {
    const left = evaluateAst(node.left, bars, cache);
    const right = evaluateAst(node.right, bars, cache);
    values = left.map((value, index) =>
      applyBinaryOperator(node.operator, value, right[index]),
    );
  } else {
    const source = evaluateAst(node.source, bars, cache);
    if (node.name === "REF") {
      values = source.map((_, index) =>
        index < node.period ? null : source[index - node.period],
      );
    } else if (node.name === "EMA") {
      values = calculateEmaSeries(source, node.period);
    } else if (node.name === "MA") {
      values = calculateWindowSeries(
        source,
        node.period,
        (window) =>
          window.reduce((sum, value) => sum + value, 0) / node.period,
      );
    } else if (node.name === "MAX") {
      values = calculateWindowSeries(source, node.period, (window) =>
        Math.max(...window),
      );
    } else {
      values = calculateWindowSeries(source, node.period, (window) =>
        Math.min(...window),
      );
    }
  }

  cache.set(node, values);
  return values;
}

export function evaluateReplayIndicator(expression, bars) {
  try {
    const ast = parseReplayIndicatorExpression(expression);
    const safeBars = Array.isArray(bars) ? bars : [];
    return {
      values: evaluateAst(ast, safeBars, new Map()),
      error: null,
    };
  } catch (error) {
    return {
      values: [],
      error:
        error instanceof ReplayIndicatorExpressionError
          ? error.message
          : "指标计算失败",
    };
  }
}

function normalizePeriod(period, fallback) {
  const numeric = Number(period);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

export function calculateMa(
  bars,
  periods = [5, 10, 20, 60],
) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const close = safeBars.map((bar) => toFiniteValue(bar?.close));
  const normalizedPeriods = Array.from(
    new Set(
      (Array.isArray(periods) ? periods : [periods])
        .map((period) => normalizePeriod(period, 0))
        .filter((period) => period > 0),
    ),
  );
  return Object.fromEntries(
    normalizedPeriods.map((period) => [
      `ma${period}`,
      calculateWindowSeries(
        close,
        period,
        (window) =>
          window.reduce((sum, value) => sum + value, 0) / period,
      ),
    ]),
  );
}

export function calculateBoll(
  bars,
  { period = 20, multiplier = 2 } = {},
) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const close = safeBars.map((bar) => toFiniteValue(bar?.close));
  const normalizedPeriod = normalizePeriod(period, 20);
  const normalizedMultiplier =
    Number.isFinite(Number(multiplier)) && Number(multiplier) >= 0
      ? Number(multiplier)
      : 2;
  const middle = calculateWindowSeries(
    close,
    normalizedPeriod,
    (window) =>
      window.reduce((sum, value) => sum + value, 0) / normalizedPeriod,
  );
  const deviation = close.map((_, index) => {
    const start = index - normalizedPeriod + 1;
    if (start < 0 || middle[index] === null) {
      return null;
    }
    const window = close.slice(start, index + 1);
    if (window.some((value) => value === null)) {
      return null;
    }
    const variance =
      window.reduce(
        (sum, value) => sum + (value - middle[index]) ** 2,
        0,
      ) / normalizedPeriod;
    return Number.isFinite(variance) ? Math.sqrt(variance) : null;
  });
  return {
    middle,
    upper: middle.map((value, index) =>
      value === null || deviation[index] === null
        ? null
        : value + deviation[index] * normalizedMultiplier,
    ),
    lower: middle.map((value, index) =>
      value === null || deviation[index] === null
        ? null
        : value - deviation[index] * normalizedMultiplier,
    ),
  };
}

export function calculateKdj(
  bars,
  { period = 9, kPeriod = 3, dPeriod = 3 } = {},
) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const normalizedPeriod = normalizePeriod(period, 9);
  const normalizedKPeriod = normalizePeriod(kPeriod, 3);
  const normalizedDPeriod = normalizePeriod(dPeriod, 3);
  const k = Array.from({ length: safeBars.length }, () => null);
  const d = Array.from({ length: safeBars.length }, () => null);
  const j = Array.from({ length: safeBars.length }, () => null);
  let previousK = 50;
  let previousD = 50;

  for (let index = 0; index < safeBars.length; index += 1) {
    const start = index - normalizedPeriod + 1;
    if (start < 0) {
      continue;
    }
    const window = safeBars.slice(start, index + 1);
    const highs = window.map((bar) => toFiniteValue(bar?.high));
    const lows = window.map((bar) => toFiniteValue(bar?.low));
    const close = toFiniteValue(safeBars[index]?.close);
    if (
      close === null ||
      highs.some((value) => value === null) ||
      lows.some((value) => value === null)
    ) {
      previousK = 50;
      previousD = 50;
      continue;
    }
    const highest = Math.max(...highs);
    const lowest = Math.min(...lows);
    const rsv =
      highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
    const nextK =
      ((normalizedKPeriod - 1) * previousK + rsv) / normalizedKPeriod;
    const nextD =
      ((normalizedDPeriod - 1) * previousD + nextK) / normalizedDPeriod;
    const nextJ = nextK * 3 - nextD * 2;
    k[index] = Number.isFinite(nextK) ? nextK : null;
    d[index] = Number.isFinite(nextD) ? nextD : null;
    j[index] = Number.isFinite(nextJ) ? nextJ : null;
    previousK = nextK;
    previousD = nextD;
  }

  return { k, d, j };
}

export function calculateMacd(
  bars,
  { shortPeriod = 12, longPeriod = 26, signalPeriod = 9 } = {},
) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const close = safeBars.map((bar) => toFiniteValue(bar?.close));
  const shortEma = calculateEmaSeries(
    close,
    normalizePeriod(shortPeriod, 12),
  );
  const longEma = calculateEmaSeries(close, normalizePeriod(longPeriod, 26));
  const dif = shortEma.map((value, index) =>
    value === null || longEma[index] === null
      ? null
      : value - longEma[index],
  );
  const dea = calculateEmaSeries(dif, normalizePeriod(signalPeriod, 9));
  const histogram = dif.map((value, index) =>
    value === null || dea[index] === null ? null : (value - dea[index]) * 2,
  );
  return {
    dif,
    dea,
    histogram,
  };
}

export function calculateRsi(bars, period = 14) {
  const safeBars = Array.isArray(bars) ? bars : [];
  const close = safeBars.map((bar) => toFiniteValue(bar?.close));
  const normalizedPeriod = normalizePeriod(period, 14);
  const result = Array.from({ length: close.length }, () => null);
  let changeCount = 0;
  let gainSum = 0;
  let lossSum = 0;
  let averageGain = null;
  let averageLoss = null;

  for (let index = 1; index < close.length; index += 1) {
    if (close[index] === null || close[index - 1] === null) {
      changeCount = 0;
      gainSum = 0;
      lossSum = 0;
      averageGain = null;
      averageLoss = null;
      continue;
    }

    const change = close[index] - close[index - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    changeCount += 1;

    if (changeCount <= normalizedPeriod) {
      gainSum += gain;
      lossSum += loss;
      if (changeCount === normalizedPeriod) {
        averageGain = gainSum / normalizedPeriod;
        averageLoss = lossSum / normalizedPeriod;
      }
    } else {
      averageGain =
        (averageGain * (normalizedPeriod - 1) + gain) / normalizedPeriod;
      averageLoss =
        (averageLoss * (normalizedPeriod - 1) + loss) / normalizedPeriod;
    }

    if (averageGain === null || averageLoss === null) {
      continue;
    }
    if (averageLoss === 0) {
      result[index] = averageGain === 0 ? 50 : 100;
      continue;
    }
    const relativeStrength = averageGain / averageLoss;
    result[index] = 100 - 100 / (1 + relativeStrength);
  }

  return result;
}
