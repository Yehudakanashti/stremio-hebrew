// Shared addon manifest. dynamic=true (Worker) adds skip + search; static (GitHub Pages) supports skip only.
module.exports = function manifest({ dynamic }) {
  const extra = dynamic ? [{ name: 'search' }, { name: 'skip' }] : [{ name: 'skip' }];
  return {
    id: 'org.kanashti.hebrew-catalog',
    version: '2.0.0',
    name: 'עם עברית',
    description: 'מציג רק סרטים וסדרות שיש להם כתוביות בעברית ב-Ktuvit או Wizdom. מתעדכן אוטומטית כל 3 שעות.',
    logo: 'https://i0.wp.com/kodibeginner.com/wp-content/uploads/2020/10/ktuvit-me.jpg?w=300&ssl=1',
    resources: ['catalog'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      { type: 'movie', id: 'heb-new', name: 'סרטים חדשים עם עברית', extra },
      { type: 'series', id: 'heb-new', name: 'סדרות חדשות עם עברית', extra },
      { type: 'movie', id: 'heb-popular', name: 'סרטים פופולריים עם עברית', extra },
      { type: 'series', id: 'heb-popular', name: 'סדרות פופולריות עם עברית', extra },
    ],
    behaviorHints: { configurable: false, configurationRequired: false },
  };
};
