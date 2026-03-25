/**
 * Spanish markdown route description generator.
 *
 * Voice: a friend showing you around. Lead with where you're going
 * and what you'll see, not infrastructure metrics. The factual data
 * (condition, width) goes in the Tramos section — useful for the
 * person who needs reassurance, but not the opening line.
 *
 * See AGENTS.md § Voice & Feel.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Format a number with Spanish decimal comma. */
function fmtNum(n, decimals = 1) {
  return n.toFixed(decimals).replace('.', ',');
}

/** Capitalize first letter of each space-separated word (handles ñ). */
function titleCase(str) {
  return str
    .toLowerCase()
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Today's date as YYYY-MM-DD. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Escape YAML string value. */
function yamlStr(str) {
  if (/[:"'#\[\]{}|>&*!%@`]/.test(str) || str.includes('\n')) {
    return `"${str.replace(/"/g, '\\"')}"`;
  }
  return `"${str}"`;
}

/** Natural list: "A, B y C". */
function naturalList(items) {
  if (items.length <= 1) return items[0] || '';
  return items.slice(0, -1).join(', ') + ' y ' + items[items.length - 1];
}

/** Format condition, filtering out "nan" and null. */
function fmtCondition(clasificacion) {
  if (!clasificacion || clasificacion === 'nan' || clasificacion === 'NaN') return null;
  return clasificacion.toLowerCase();
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Build the full index.md content for a route proposal.
 *
 * @param {object} route - route object from stitchTrips()
 * @returns {string} markdown with YAML frontmatter
 */
export function buildMarkdown(route) {
  const distKm = route.totalDistanceM / 1000;
  const dateStr = today();

  // --- Frontmatter ---
  const tags = route.suggestedTags.map((t) => `  - ${t}`).join('\n');
  // YAML frontmatter uses period decimals (machine-readable)
  const distYaml = distKm.toFixed(1);
  const frontmatter = `---
name: ${yamlStr(route.name)}
status: published
distance_km: ${distYaml}
tags:
${tags}
created_at: "${dateStr}"
updated_at: "${dateStr}"
variants:
  - name: ${yamlStr(route.name)}
    gpx: main.gpx
    distance_km: ${distYaml}
---`;

  // --- Body ---
  const sections = [];

  // Opening — lead with where you're going, not metrics
  const allComunas = [...new Set(route.axes.flatMap((a) => a.comunas).filter(Boolean))];
  const comunasStr = naturalList(allComunas.map(titleCase));

  const archetype = route.archetype || 'point-to-point';
  let opening;

  if (archetype === 'loop') {
    opening = `Un circuito de ${fmtNum(distKm)} kilómetros por ${comunasStr}`;
    if (route.startAnchor?.name) {
      opening += `, saliendo desde ${route.startAnchor.name}`;
    }
    opening += '.';
  } else {
    opening = `${fmtNum(distKm)} kilómetros por ${comunasStr}`;
    if (route.startAnchor?.name && route.endAnchor?.name &&
        route.startAnchor.name !== route.endAnchor.name) {
      opening += `, desde ${route.startAnchor.name} hasta ${route.endAnchor.name}`;
    }
    opening += '.';
  }

  // Infrastructure coverage as context, not headline
  if (route.infraPercent >= 90) {
    opening += ' Prácticamente todo el recorrido tiene ciclovía.';
  } else if (route.infraPercent >= 70) {
    opening += ` El ${route.infraPercent}% del recorrido tiene ciclovía.`;
  } else if (route.infraPercent >= 50) {
    opening += ` Alrededor de la mitad del recorrido tiene ciclovía.`;
  }

  sections.push(opening);

  // --- Tramos section: consolidate by axis, not individual segments ---
  if (route.axes.length > 0) {
    const lines = ['### Tramos', ''];
    for (const axis of route.axes) {
      const axisName = titleCase(axis.name || 'Sin nombre');
      const axisComunas = (axis.comunas || []).filter(Boolean).map(titleCase);
      const axisKm = fmtNum(axis.totalInfraM / 1000);

      // Summarize the axis as one entry
      let line = `**${axisName}**`;
      if (axisComunas.length > 0) line += ` (${naturalList(axisComunas)})`;
      line += ` — ${axisKm} km`;

      // Collect unique infrastructure properties across segments
      const tipos = [...new Set(axis.segments.map((s) => s.tipo).filter(Boolean))];
      if (tipos.length > 0) line += `, ${tipos.join('/')}`;

      const emplazamientos = [...new Set(axis.segments.map((s) => s.emplazamiento).filter(Boolean))];
      if (emplazamientos.length > 0) line += `, en ${naturalList(emplazamientos)}`;

      const widths = axis.segments.map((s) => s.ancho_cm).filter((w) => w != null && w > 0);
      if (widths.length > 0) {
        const minW = Math.min(...widths);
        const maxW = Math.max(...widths);
        if (minW === maxW) {
          line += `, ${minW} cm de ancho`;
        } else {
          line += `, ${minW}–${maxW} cm de ancho`;
        }
      }

      line += '.';

      // Condition summary — show range if varied, skip "nan"
      const conditions = axis.segments
        .map((s) => fmtCondition(s.clasificacion))
        .filter(Boolean);
      const uniqueConditions = [...new Set(conditions)];
      if (uniqueConditions.length === 1) {
        line += `\nEvaluación Pedaleable: "${uniqueConditions[0]}".`;
      } else if (uniqueConditions.length > 1) {
        line += `\nEvaluación Pedaleable: de "${uniqueConditions[uniqueConditions.length - 1]}" a "${uniqueConditions[0]}".`;
      }

      lines.push(line);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Tramos sin infraestructura: use axis names instead of coordinates ---
  const significantGaps = route.gaps.filter((g) => g.distanceM > 50);
  if (significantGaps.length > 0) {
    const lines = ['### Tramos sin infraestructura', ''];
    for (let gi = 0; gi < significantGaps.length; gi++) {
      const gap = significantGaps[gi];
      const distStr = gap.distanceM >= 1000
        ? `${fmtNum(gap.distanceM / 1000)} km`
        : `${Math.round(gap.distanceM)} m`;

      // Find the axis before and after this gap
      const beforeAxis = route.axes.find((a) => a.slug === gap.afterAxis);
      const afterAxisIdx = route.axes.findIndex((a) => a.slug === gap.afterAxis);
      const afterAxis = afterAxisIdx >= 0 && afterAxisIdx + 1 < route.axes.length
        ? route.axes[afterAxisIdx + 1]
        : null;

      const fromName = beforeAxis ? titleCase(beforeAxis.name || 'tramo anterior') : 'tramo anterior';
      const toName = afterAxis ? titleCase(afterAxis.name || 'siguiente tramo') : 'siguiente tramo';

      lines.push(`Entre **${fromName}** y **${toName}** — ${distStr} sin infraestructura ciclista.`);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Video section: deduplicate by URL ---
  const allSegments = route.axes.flatMap((a) => a.segments);
  const seenVideos = new Set();
  const uniqueVideoSegments = [];
  for (const seg of allSegments) {
    if (seg.video && !seenVideos.has(seg.video.trim())) {
      seenVideos.add(seg.video.trim());
      uniqueVideoSegments.push(seg);
    }
  }

  if (uniqueVideoSegments.length > 0) {
    const lines = [
      'Videos a nivel de calle de cada tramo, grabados por Pedaleable:',
      '',
    ];
    for (const seg of uniqueVideoSegments) {
      lines.push(seg.video.trim());
    }
    lines.push('');
    sections.push(lines.join('\n'));
  }

  return frontmatter + '\n\n' + sections.join('\n\n') + '\n';
}
