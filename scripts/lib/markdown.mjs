/**
 * Spanish markdown route description generator.
 *
 * Generates index.md content (YAML frontmatter + markdown body)
 * from a route proposal object.
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

/** Escape YAML string value (wrap in quotes if it contains special chars). */
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

  // Opening paragraph
  const allComunas = [...new Set(route.axes.flatMap((a) => a.comunas).filter(Boolean))];
  const comunasStr = allComunas.map(titleCase).join(', ');
  let opening = `${fmtNum(distKm)} kilómetros por ${comunasStr}.`;

  if (route.infraPercent >= 80) {
    opening += ' En su mayoría por ciclovías protegidas.';
  } else if (route.infraPercent >= 50) {
    opening += ` Con infraestructura ciclista en el ${route.infraPercent}% del recorrido.`;
  } else {
    opening += ` Solo el ${route.infraPercent}% del recorrido tiene infraestructura ciclista.`;
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
      lines.push(`**${gap.afterAxis} →** — ${distStr} sin infraestructura ciclista.`);
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
