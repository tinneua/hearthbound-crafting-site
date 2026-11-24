const query = document.querySelector('#query');
const clear = document.querySelector('#clear');
const status = document.querySelector('#status');
const workspace = document.querySelector('.workspace');
const results = document.querySelector('#results');
const matchCount = document.querySelector('#match-count');
const title = document.querySelector('#recipe-title');
const profession = document.querySelector('#profession');
const crafterCount = document.querySelector('#crafter-count');
const crafters = document.querySelector('#crafters');
const showCrafters = document.querySelector('#show-crafters');
const materials = document.querySelector('#materials');
const materialsStatus = document.querySelector('#materials-status');
const copyLink = document.querySelector('#copy-link');
const copyStatus = document.querySelector('#copy-status');
const previewCount = 4;

let recipes = [];
let matches = [];
let selected;

function label(recipe) {
  return recipe.item?.name ?? recipe.name;
}

function normalize(value) {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '')
    .toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, ' ').trim();
}

function rank(names, term, words) {
  let score = Infinity;
  for (const name of names) {
    if (name === term) return 0;
    if (name.startsWith(term)) score = Math.min(score, 1);
    else if (name.includes(term)) score = Math.min(score, 2);
    else if (words.every(word => name.includes(word))) score = Math.min(score, 3);
  }
  return score;
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = value;
  return node;
}

function itemLink(item, size) {
  const link = element('a', 'wowhead-item', item.name);
  link.href = `https://www.wowhead.com/forever/item=${item.id}`;
  link.dataset.whIconSize = size;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.referrerPolicy = 'no-referrer';
  return link;
}

function renderRecipe(recipe) {
  selected = recipe;
  profession.textContent = recipe.profession;
  title.replaceChildren(recipe.item ? itemLink(recipe.item, 'medium') : recipe.name);
  copyStatus.textContent = '';

  crafterCount.textContent = recipe.crafters.length;
  crafters.replaceChildren(...recipe.crafters.map((character, index) => {
    const row = element('li', index >= previewCount ? 'additional-crafter' : '', character.name);
    row.hidden = index >= previewCount;
    return row;
  }));
  showCrafters.hidden = recipe.crafters.length <= previewCount;
  showCrafters.setAttribute('aria-expanded', 'false');
  showCrafters.textContent = `Show all ${recipe.crafters.length} crafters ↓`;

  materials.replaceChildren(...(recipe.materials ?? []).map(material => {
    const row = element('li');
    row.append(itemLink(material, 'small'), element('span', 'quantity', `×${material.quantity}`));
    return row;
  }));
  materialsStatus.hidden = Boolean(recipe.materials?.length);
  materialsStatus.textContent = recipe.materials
    ? 'No materials required.'
    : 'Blizzard did not provide a materials list for this recipe.';

  for (const result of results.children) {
    const active = result.dataset.id === String(recipe.id);
    result.classList.toggle('active', active);
    result.setAttribute('aria-pressed', String(active));
  }
  window.$WowheadPower?.refreshLinks?.();
}

function setStatus(message) {
  status.textContent = message;
  status.hidden = !message;
}

function showMatches(preferredId) {
  const term = normalize(query.value);
  clear.hidden = !query.value;
  const words = term.split(' ');
  matches = term ? recipes
    .map(recipe => ({recipe, score: rank(recipe.searchNames, term, words)}))
    .filter(({score}) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || label(a.recipe).localeCompare(label(b.recipe)))
    .map(({recipe}) => recipe) : [];

  workspace.hidden = matches.length === 0;
  matchCount.textContent = `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
  setStatus(matches.length ? '' : term
    ? 'No known guild recipes match that search.'
    : 'Enter an item or recipe name to get started.');
  results.replaceChildren(...matches.map(recipe => {
    const button = element('button', 'result');
    button.type = 'button';
    button.dataset.id = recipe.id;
    const info = element('span');
    info.append(element('span', 'result-name', label(recipe)),
      element('span', 'result-meta', recipe.profession));
    const count = recipe.crafters.length;
    button.append(info, element('span', 'result-count', `${count} ${count === 1 ? 'crafter' : 'crafters'}`));
    return button;
  }));
  const recipe = matches.find(recipe => recipe.id === preferredId) ?? matches[0];
  if (recipe) renderRecipe(recipe);
  else selected = undefined;
}

function showLocation() {
  const params = new URLSearchParams(location.search);
  const recipeId = Number(params.get('recipe'));
  const recipe = recipes.find(entry => entry.id === recipeId);
  query.value = params.get('q') ?? (recipe ? label(recipe) : '');
  showMatches(recipeId);
  if (params.has('recipe') && !recipe && !query.value) {
    setStatus('This recipe is no longer in the current guild catalog. Search for another item.');
  }
}

function updateLocation(method) {
  const url = new URL(location.href);
  if (query.value.trim()) url.searchParams.set('q', query.value.trim());
  else url.searchParams.delete('q');
  if (selected) url.searchParams.set('recipe', selected.id);
  else url.searchParams.delete('recipe');
  if (url.href !== location.href) history[method](null, '', url);
}

function search() {
  showMatches();
  updateLocation('replaceState');
}

query.addEventListener('input', search);
clear.addEventListener('click', () => {
  query.value = '';
  search();
  query.focus();
});
query.form.addEventListener('submit', event => {
  event.preventDefault();
  if (selected) title.focus();
});

results.addEventListener('click', event => {
  const button = event.target.closest('button[data-id]');
  if (!button) return;
  const recipe = matches.find(entry => entry.id === Number(button.dataset.id));
  if (recipe.id !== selected?.id) {
    renderRecipe(recipe);
    updateLocation('pushState');
  }
  if (matchMedia('(max-width: 750px)').matches) {
    title.focus({preventScroll: true});
    workspace.querySelector('.details').scrollIntoView({block: 'start'});
  }
});

showCrafters.addEventListener('click', () => {
  const expanded = showCrafters.getAttribute('aria-expanded') === 'true';
  for (const row of crafters.querySelectorAll('.additional-crafter')) row.hidden = expanded;
  showCrafters.setAttribute('aria-expanded', String(!expanded));
  showCrafters.textContent = expanded ? `Show all ${selected.crafters.length} crafters ↓` : 'Show fewer crafters ↑';
});

copyLink.addEventListener('click', async () => {
  const link = new URL(location.pathname, location.origin);
  link.searchParams.set('recipe', selected.id);
  try {
    await navigator.clipboard.writeText(link.href);
    copyStatus.textContent = 'Recipe link copied.';
  } catch {
    copyStatus.replaceChildren('Could not copy. ', element('a', 'wowhead-item', 'Open the recipe link'));
    copyStatus.lastElementChild.href = link;
  }
});

window.addEventListener('popstate', showLocation);

async function loadCatalog() {
  try {
    const response = await fetch('catalog.json', {cache: 'no-cache'});
    if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    const snapshot = await response.json();
    if (snapshot.schema_version !== 1) throw new Error('Unknown catalog format');
    const expiry = Date.parse(snapshot.expires_at);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      setStatus('The crafting catalog has expired. Check back after the next successful refresh.');
      return;
    }
    recipes = snapshot.recipes.map(recipe => ({
      ...recipe, searchNames: [recipe.name, label(recipe)].map(normalize),
    }));

    const refreshed = document.querySelector('#refreshed');
    refreshed.dateTime = snapshot.refreshed_at;
    refreshed.textContent = new Intl.DateTimeFormat('en-GB', {dateStyle: 'medium', timeZone: 'UTC'})
      .format(new Date(snapshot.refreshed_at));
    document.querySelector('footer').hidden = false;
    query.disabled = false;
    showLocation();
  } catch (error) {
    console.error(error);
    setStatus('The crafting catalog is unavailable. Try again after it refreshes.');
  }
}

loadCatalog();
