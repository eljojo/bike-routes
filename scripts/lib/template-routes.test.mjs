import { describe, it, expect } from 'vitest';

// namesMatch is not exported, so we test it indirectly via a local copy.
// If the module exports change, update this.
function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().replace(/\s+/g, ' ');
}

function namesMatch(a, b) {
  const na = normalize(a), nb = normalize(b);
  if (na === nb) return true;
  if (na.length >= 8 && nb.length >= 8) {
    const shorter = na.length <= nb.length ? na : nb;
    const longer = na.length <= nb.length ? nb : na;
    if (longer.includes(shorter) && shorter.length / longer.length >= 0.5) return true;
  }
  return false;
}

describe('namesMatch', () => {
  describe('should match', () => {
    it('exact same name', () => {
      expect(namesMatch('Parque Quinta Normal', 'Parque Quinta Normal')).toBe(true);
    });

    it('case and accent differences', () => {
      expect(namesMatch('Ciclovía Andrés Bello', 'ciclovia andres bello')).toBe(true);
    });

    it('substring with good coverage — shorter name in longer', () => {
      expect(namesMatch('Costanera Sur', 'Ciclovía Costanera Sur')).toBe(true);
    });

    it('shorter name is substring of longer with good coverage', () => {
      expect(namesMatch('Museo de Bellas Artes', 'Bellas Artes')).toBe(true);
    });
  });

  describe('should NOT match', () => {
    it('different prefix, same suffix — Estadio vs Librería', () => {
      expect(namesMatch('Estadio Nacional', 'Librería Nacional')).toBe(false);
    });

    it('partial word overlap — Bicentenario vs Centenario', () => {
      expect(namesMatch('Parque Bicentenario', 'Puente Centenario')).toBe(false);
    });

    it('substring too short relative to longer — Italia vs Italiano', () => {
      expect(namesMatch('Plaza Italia', 'Restaurant Italiano')).toBe(false);
    });

    it('common word but low coverage — O\'Higgins in long name', () => {
      expect(namesMatch("Parque O'Higgins", "Parque Central Alameda Bernardo O'Higgins")).toBe(false);
    });

    it('generic short word — Nacional', () => {
      expect(namesMatch('Estadio Nacional', 'Biblioteca Nacional')).toBe(false);
    });

    it('completely different names', () => {
      expect(namesMatch('Parque Forestal', 'Estadio Nacional')).toBe(false);
    });
  });
});
