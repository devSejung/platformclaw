type Box = { x: number; y: number; width: number; height: number };
const measurements = new WeakMap<
  SVGTextElement,
  { text: string; font: string; wrapped: boolean; width: number; height: number }
>();

export function placeSvgGraphLabels(svg: SVGSVGElement, scale = 1, panX = 0, panY = 0) {
  const nodes = [...svg.querySelectorAll<SVGGElement>("[data-svg-graph-node]")];
  const screenScale = Math.abs(svg.getScreenCTM?.()?.a ?? 1) * scale;
  const frame = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/u).map(Number);
  const margin = 8 / Math.max(0.1, screenScale);
  const fontFamily = getComputedStyle(svg).fontFamily;
  const cells = new Map<string, Box[]>();
  const keys = (box: Box) => {
    const result: string[] = [];
    for (let x = Math.floor(box.x / 80); x <= Math.floor((box.x + box.width) / 80); x += 1) {
      for (let y = Math.floor(box.y / 80); y <= Math.floor((box.y + box.height) / 80); y += 1) {
        result.push(`${x},${y}`);
      }
    }
    return result;
  };
  const occupy = (box: Box) => {
    for (const key of keys(box)) {
      const occupants = cells.get(key) ?? [];
      occupants.push(box);
      cells.set(key, occupants);
    }
  };
  const overlaps = (box: Box) =>
    keys(box).some((key) =>
      cells
        .get(key)
        ?.some(
          (other) =>
            box.x < other.x + other.width &&
            box.x + box.width > other.x &&
            box.y < other.y + other.height &&
            box.y + box.height > other.y,
        ),
    );
  const point = (node: SVGGElement) => {
    const coordinates = node.getAttribute("transform")?.match(/translate\(([^ ]+) ([^)]+)\)/u);
    return { x: Number(coordinates?.[1] ?? 0), y: Number(coordinates?.[2] ?? 0) };
  };
  for (const node of nodes) {
    const { x, y } = point(node);
    const radius = Number(node.querySelector("circle")?.getAttribute("r") ?? 10) + 5;
    occupy({ x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 });
  }
  // Keep the inspected/dragged/focused title readable first. Other crowded
  // titles reveal on hover/focus and remain available in the document picker.
  const priority = (node: SVGGElement) =>
    node.dataset.svgGraphState === "active" ? 2 : node.dataset.svgGraphState === "neighbor" ? 1 : 0;
  nodes.sort((a, b) => priority(b) - priority(a));
  for (const node of nodes) {
    const label = node.querySelector<SVGTextElement>("text");
    if (!label) {
      continue;
    }
    // Large snapshots prioritize the inspected neighborhood during motion.
    if (nodes.length > 100 && node.dataset.svgGraphState === "muted") {
      label.style.visibility = "hidden";
      continue;
    }
    const fullTitle = label.dataset.svgGraphLabel;
    const expanded = priority(node) > 0 || (scale >= 1.3 && node.dataset.svgGraphState === "idle");
    const text = fullTitle
      ? expanded
        ? fullTitle
        : (label.dataset.svgGraphShortLabel ?? fullTitle)
      : (label.textContent ?? "");
    const fontSize = Math.min(
      priority(node) ? Number.POSITIVE_INFINITY : 28,
      (priority(node) ? 12 : 10) / Math.max(0.1, screenScale),
    );
    label.style.fontSize = `${fontSize}px`;
    const font = `${fontSize} ${priority(node) ? 500 : 400} ${fontFamily}`;
    const shorten = (length: number) =>
      `${Array.from(text)
        .slice(0, length - 1)
        .join("")}…`;
    const variants = priority(node) && text.length > 14 ? [text, shorten(14), shorten(8)] : [text];
    const { x, y } = point(node);
    let placed = false;
    for (const variant of variants) {
      const wrapped = expanded && variant === text;
      let size = measurements.get(label);
      if (!size || size.text !== variant || size.font !== font || size.wrapped !== wrapped) {
        if (fullTitle) {
          // Lit owns the title attributes, and this placer owns the text children.
          // Expanded titles wrap so hover/focus/selection and zoom remain readable.
          const lines = wrapped
            ? (variant.match(/.{1,20}(?:\s|$)|.{1,20}/gu) ?? [variant])
            : [variant];
          label.replaceChildren(
            ...lines.map((line, index) => {
              const span = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
              span.setAttribute("x", "0");
              span.setAttribute("dy", String(index ? fontSize * 1.25 : 0));
              span.textContent = line;
              return span;
            }),
          );
        }
        const bounds = label.getBBox?.();
        size = {
          text: variant,
          font,
          wrapped,
          width: bounds?.width || variant.length * 7.5,
          height: bounds?.height || 15,
        };
        measurements.set(label, size);
      }
      // A title must stay beside its dot. If a full title cannot fit nearby,
      // shorten it; the native title, picker and inspector retain the full text.
      const rings = priority(node) ? 2 : 5;
      for (let ring = 0; ring < rings && !placed; ring += 1) {
        const gap = 17 + ring * 18;
        const candidates = [
          { x: gap, y: -size.height / 2 },
          { x: -gap - size.width, y: -size.height / 2 },
          { x: -size.width / 2, y: gap },
          { x: -size.width / 2, y: -gap - size.height },
        ];
        if (priority(node)) {
          candidates.push(
            { x: gap, y: gap },
            { x: -gap - size.width, y: gap },
            { x: gap, y: -gap - size.height },
            { x: -gap - size.width, y: -gap - size.height },
          );
        }
        for (const candidate of candidates) {
          const box = {
            x: x + candidate.x - 3,
            y: y + candidate.y - 3,
            width: size.width + 6,
            height: size.height + 6,
          };
          if (
            overlaps(box) ||
            (frame?.length === 4 &&
              (box.x < (frame[0]! - panX) / scale + margin ||
                box.y < (frame[1]! - panY) / scale + margin ||
                box.x + box.width > (frame[0]! + frame[2]! - panX) / scale - margin ||
                box.y + box.height > (frame[1]! + frame[3]! - panY) / scale - margin))
          ) {
            continue;
          }
          occupy(box);
          label.setAttribute("x", String(candidate.x));
          label.setAttribute("y", String(candidate.y + fontSize * 0.8));
          label.setAttribute("text-anchor", "start");
          for (const span of label.querySelectorAll("tspan")) {
            span.setAttribute("x", String(candidate.x));
          }
          placed = true;
          break;
        }
      }
      if (placed) {
        break;
      }
    }
    label.style.visibility = placed ? "visible" : "hidden";
  }
}
