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

/** Capitalize first letter of each word. */
function titleCase(str) {
  return str.replace(/\b\w/g, (c) => c.toUpperCase());
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
  const frontmatter = `---
name: ${yamlStr(route.name)}
status: published
distance_km: ${fmtNum(distKm)}
tags:
${tags}
created_at: "${dateStr}"
updated_at: "${dateStr}"
variants:
  - name: ${yamlStr(route.name)}
    gpx: main.gpx
    distance_km: ${fmtNum(distKm)}
---`;

  // --- Body ---
  const sections = [];

  // Opening — lead with where you're going, not metrics
  const allComunas = [...new Set(route.axes.flatMap((a) => a.comunas).filter(Boolean))];
  const comunasStr = allComunas.map(titleCase).join(' y ');

  let opening = `${fmtNum(distKm)} kilómetros por ${comunasStr}`;

  // Mention the destination anchors
  if (route.startAnchor?.name && route.endAnchor?.name &&
      route.startAnchor.name !== route.endAnchor.name) {
    opening += `, desde ${route.startAnchor.name} hasta ${route.endAnchor.name}`;
  }
  opening += '.';

  // Infrastructure coverage as context, not headline
  if (route.infraPercent >= 90) {
    opening += ' Prácticamente todo el recorrido tiene ciclovía.';
  } else if (route.infraPercent >= 70) {
    opening += ` El ${route.infraPercent}% del recorrido tiene ciclovía.`;
  } else if (route.infraPercent >= 50) {
    opening += ` Alrededor de la mitad del recorrido tiene ciclovía.`;
  }

  sections.push(opening);

  // --- Tramos section ---
  const allSegments = route.axes.flatMap((a) => a.segments);
  if (allSegments.length > 0) {
    const lines = ['### Tramos', ''];
    for (const seg of allSegments) {
      const comuna = seg.comuna ? titleCase(seg.comuna) : '';
      const km = fmtNum(seg.lengthM / 1000);
      const parts = [`**${seg.nombre}**`];
      if (comuna) parts[0] += ` (${comuna})`;
      parts[0] += ` — ${km} km`;
      if (seg.tipo) parts.push(seg.tipo);
      if (seg.emplazamiento) parts.push(`en ${seg.emplazamiento}`);
      if (seg.ancho_cm) parts.push(`${seg.ancho_cm} cm de ancho`);

      let line = parts.join(', ') + '.';

      if (seg.clasificacion) {
        line += `\nEvaluación Pedaleable (2022): "${seg.clasificacion}".`;
      }
      if (seg.video) {
        line += `\n[Video de este tramo](${seg.video})`;
      }

      lines.push(line);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Tramos sin infraestructura ---
  const significantGaps = route.gaps.filter((g) => g.distanceM > 50);
  if (significantGaps.length > 0) {
    const lines = ['### Tramos sin infraestructura', ''];
    for (const gap of significantGaps) {
      const distStr = gap.distanceM >= 1000
        ? `${fmtNum(gap.distanceM / 1000)} km`
        : `${Math.round(gap.distanceM)} m`;
      lines.push(`**${gap.from || gap.afterAxis} → ${gap.to || ''}** — ${distStr} sin infraestructura ciclista.`);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Video section ---
  const segmentsWithVideo = allSegments.filter((s) => s.video);
  if (segmentsWithVideo.length > 0) {
    const lines = [
      '### Video',
      '',
      'Videos a nivel de calle de cada tramo, grabados por Pedaleable:',
      '',
    ];
    for (const seg of segmentsWithVideo) {
      lines.push(`- [${seg.nombre}](${seg.video})`);
    }
    lines.push('');
    sections.push(lines.join('\n'));
  }

  return frontmatter + '\n\n' + sections.join('\n\n') + '\n';
}
