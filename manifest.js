// Shared addon manifest. dynamic=true (Worker) adds search; static (GitHub Pages) supports skip only.
const GENRES = require('./genres.js');

function catalogsFor(type, extra) {
  const label = type === 'series' ? 'סדרות' : 'סרטים';
  const newName = type === 'series' ? 'סדרות חדשות עם עברית' : 'סרטים חדשים עם עברית';
  const popName = type === 'series' ? 'סדרות פופולריות עם עברית' : 'סרטים פופולריים עם עברית';
  return [
    { type, id: 'heb-new', name: newName, extra },
    { type, id: 'heb-popular', name: popName, extra },
    ...GENRES.map(g => ({ type, id: `heb-genre-${g.key}`, name: `${label}: ${g.name}`, extra })),
  ];
}

module.exports = function manifest({ dynamic }) {
  const extra = dynamic ? [{ name: 'search' }, { name: 'skip' }] : [{ name: 'skip' }];
  return {
    id: 'org.kanashti.hebrew-catalog',
    version: '2.1.0',
    name: 'עם עברית',
    description: 'מציג רק סרטים וסדרות שיש להם כתוביות בעברית ב-Ktuvit או Wizdom, מסודרים לפי ז\'אנר. מתעדכן אוטומטית כל 3 שעות.',
    logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [...catalogsFor('series', extra), ...catalogsFor('movie', extra)],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
};
module.exports.GENRES = GENRES;
