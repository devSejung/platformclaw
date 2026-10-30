/** Remove unavailable resource declarations without reserializing unrelated modern CSS. */
export function omitHtmlPreviewCssAssets(css: string): { css: string; omitted: boolean } {
  const removals: Array<{ start: number; end: number }> = [];
  let statementStart = 0;
  let unsupportedAsset = false;
  let parentheses = 0;
  const functions: string[] = [];
  let quote = "";
  let quotedValueStart = 0;
  let imageSetString = false;
  let comment = false;
  const finishStatement = (end: number, includeTerminator: boolean) => {
    const statement = css.slice(statementStart, end).replace(/\/\*[\s\S]*?\*\//gu, "");
    if (unsupportedAsset || /^\s*@import\b/iu.test(statement)) {
      removals.push({ start: statementStart, end: end + (includeTerminator ? 1 : 0) });
    }
    statementStart = end + 1;
    unsupportedAsset = false;
  };
  for (let index = 0; index < css.length; index++) {
    const character = css[index];
    if (comment) {
      if (character === "*" && css[index + 1] === "/") {
        comment = false;
        index++;
      }
      continue;
    }
    if (character === "\\") {
      index++;
      continue;
    }
    if (quote) {
      if (character === quote) {
        if (
          imageSetString &&
          !/^(?:data:|blob:|#)/iu.test(css.slice(quotedValueStart, index).trim())
        ) {
          unsupportedAsset = true;
        }
        quote = "";
      }
      continue;
    }
    if (character === "/" && css[index + 1] === "*") {
      comment = true;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      quotedValueStart = index + 1;
      // image-set strings are resource URLs; type("image/png") strings are
      // descriptors instead, so inspect only the immediate enclosing function.
      imageSetString = /^(?:-webkit-)?image-set$/iu.test(functions.at(-1) ?? "");
      continue;
    }
    const url =
      character === "u" || character === "U" ? /^url\s*\(/iu.exec(css.slice(index)) : null;
    if (url && (index === 0 || !/[\w-]/u.test(css[index - 1] ?? ""))) {
      const valueStart = index + url[0].length;
      let valueEnd = valueStart;
      let valueQuote = "";
      for (; valueEnd < css.length; valueEnd++) {
        const valueCharacter = css[valueEnd];
        if (valueCharacter === "\\") {
          valueEnd++;
        } else if (valueQuote) {
          if (valueCharacter === valueQuote) {
            valueQuote = "";
          }
        } else if (valueCharacter === '"' || valueCharacter === "'") {
          valueQuote = valueCharacter;
        } else if (valueCharacter === ")") {
          break;
        }
      }
      const value = css
        .slice(valueStart, valueEnd)
        .trim()
        .replace(/^(["'])([\s\S]*)\1$/u, "$2");
      if (!/^(?:data:|blob:|#)/iu.test(value)) {
        unsupportedAsset = true;
      }
      index = valueEnd;
      continue;
    }
    if (character === "(") {
      let nameEnd = index;
      while (nameEnd > 0 && /\s/u.test(css[nameEnd - 1] ?? "")) {
        nameEnd--;
      }
      let nameStart = nameEnd;
      while (nameStart > 0 && /[\w-]/u.test(css[nameStart - 1] ?? "")) {
        nameStart--;
      }
      functions.push(css.slice(nameStart, nameEnd));
      parentheses++;
    } else if (character === ")") {
      functions.pop();
      parentheses = Math.max(0, parentheses - 1);
    } else if (parentheses === 0) {
      if (character === "{") {
        statementStart = index + 1;
        unsupportedAsset = false;
      } else if (character === ";" || character === "}") {
        finishStatement(index, character === ";");
      }
    }
  }
  finishStatement(css.length, false);
  if (removals.length === 0) {
    return { css, omitted: false };
  }
  let preserved = "";
  let offset = 0;
  for (const removal of removals) {
    preserved += css.slice(offset, removal.start);
    offset = removal.end;
  }
  return { css: preserved + css.slice(offset), omitted: true };
}
