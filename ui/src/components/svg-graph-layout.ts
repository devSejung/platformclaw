type GraphPoint = { x: number; y: number };
type GraphEdge = { source: string; target: string };

// This bounded SVG layout owns only coordinates. API documents, directed edges,
// and their permissions stay with the caller; reciprocal links share one spring.
export function createSvgGraphLayout(
  nodes: ReadonlyArray<{ id: string }>,
  edges: ReadonlyArray<GraphEdge>,
  width: number,
  height: number,
) {
  const bodies = nodes
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((node, index) => {
      const angle = index * Math.PI * (3 - Math.sqrt(5));
      const radius = nodes.length === 1 ? 0 : 58 * Math.sqrt(index + 1);
      return {
        id: node.id,
        x: width / 2 + Math.cos(angle) * radius,
        y: height / 2 + Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      };
    });
  const positions = new Map<string, GraphPoint>(bodies.map((body) => [body.id, body]));
  const byId = new Map(bodies.map((body) => [body.id, body]));
  const pairs = new Set<string>();
  const links = edges.flatMap((edge) => {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    const pair = [edge.source, edge.target].toSorted().join("\0");
    if (!source || !target || source === target || pairs.has(pair)) {
      return [];
    }
    pairs.add(pair);
    return [{ source, target }];
  });
  const degrees = new Map<string, number>();
  for (const { source, target } of links) {
    degrees.set(source.id, (degrees.get(source.id) ?? 0) + 1);
    degrees.set(target.id, (degrees.get(target.id) ?? 0) + 1);
  }
  let pinned: string | null = null;
  let heat = 1;
  const tick = () => {
    for (const body of bodies) {
      body.vx += (width / 2 - body.x) * 0.002 * heat;
      body.vy += (height / 2 - body.y) * 0.002 * heat;
    }
    for (let index = 0; index < bodies.length; index += 1) {
      const source = bodies[index]!;
      for (let other = index + 1; other < bodies.length; other += 1) {
        const target = bodies[other]!;
        const dx = target.x - source.x || 0.01;
        const dy = target.y - source.y || 0.01;
        const squared = dx * dx + dy * dy;
        const distance = Math.sqrt(squared);
        const repulsion = Math.min(8, 6000 / Math.max(100, squared)) * heat;
        const collision = Math.max(0, 70 - distance) * 0.25;
        const force = (repulsion + collision) / distance;
        source.vx -= dx * force;
        source.vy -= dy * force;
        target.vx += dx * force;
        target.vy += dy * force;
      }
    }
    for (const { source, target } of links) {
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.hypot(dx, dy) || 1;
      const degree = Math.max(degrees.get(source.id)!, degrees.get(target.id)!);
      const force = ((distance - 190) / distance) * (0.07 / Math.sqrt(degree)) * heat;
      source.vx += dx * force;
      source.vy += dy * force;
      target.vx -= dx * force;
      target.vy -= dy * force;
    }
    for (const body of bodies) {
      if (body.id === pinned) {
        body.vx = body.vy = 0;
      } else {
        body.vx = Math.max(-24, Math.min(24, body.vx * 0.68));
        body.vy = Math.max(-24, Math.min(24, body.vy * 0.68));
        body.x += body.vx;
        body.y += body.vy;
      }
    }
    heat = pinned ? Math.max(0.3, heat * 0.95) : heat * 0.95;
    return heat > 0.015;
  };
  // No initial animation or timer. Cap quadratic work for the API's 500-node
  // snapshot; subsequent ticks run only during a user drag and its short cooldown.
  const initialTicks = Math.min(64, Math.max(16, Math.floor(12_000 / Math.max(1, nodes.length))));
  for (let index = 0; index < initialTicks; index += 1) {
    tick();
  }
  const initial = new Map(bodies.map((body) => [body.id, { x: body.x, y: body.y }]));
  return {
    positions,
    tick,
    pin(id: string, point: GraphPoint) {
      pinned = id;
      Object.assign(byId.get(id)!, point, { vx: 0, vy: 0 });
      heat = Math.max(heat, 0.6);
    },
    release() {
      pinned = null;
    },
    reset() {
      pinned = null;
      heat = 0;
      for (const body of bodies) {
        Object.assign(body, initial.get(body.id), { vx: 0, vy: 0 });
      }
    },
  };
}
