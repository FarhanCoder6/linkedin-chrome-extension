const POPUP_ID = 'linkedin-extension-role-popup';
const ROLE_BADGE_CLASS = 'linkedin-extension-role-badge';
const ROLE_BADGE_ROW_CLASS = 'linkedin-extension-role-badge-row';
const ROLE_BADGE_LEFT_CLASS = 'linkedin-extension-role-badge-left';
const ROLE_BADGE_RIGHT_CLASS = 'linkedin-extension-role-badge-right';
const FLAG_BADGE_CLASS = 'linkedin-extension-flag-badge';
const MESSAGE_CARD_SELECTOR = '[id^="overlay-conversation-card-"]';
const MESSAGE_CARD_CONTAINER_SELECTOR = MESSAGE_CARD_SELECTOR;
const INTEROP_OUTLET_SELECTOR = '#interop-outlet';
const FLAG_COLORS_STORAGE_KEY = 'linkedin-extension-flag-colors';
const CARD_TAGS_STORAGE_KEY = 'linkedin-extension-card-tags';
const DEFAULT_FLAG_COLORS = ['green', 'yellow', 'red'];

let activeMessageCard: HTMLElement | null = null;
type CardTag = { role?: string; roles?: string[]; flagColor?: string };
let cardTags: Record<string, CardTag> = {};
let currentFilterQuery = '';

const normalizeUrnValue = (value: string) => value.trim().replace(/^urn:(urn:)+/i, 'urn:');

const normalizeHrefValue = (value: string) => {
  const raw = value.trim();
  if (!raw) {
    return raw;
  }

  try {
    const url = new URL(raw, window.location.origin);
    const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin}${normalizedPath}`;
  } catch {
    return raw.split('#')[0].split('?')[0].replace(/\/+$/, '');
  }
};

const pushUnique = (target: string[], value: string) => {
  if (!value || target.includes(value)) {
    return;
  }

  target.push(value);
};

const createFlagSvg = (color: string, size: number) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
  <path fill="${color}" d="M5 2a1 1 0 0 1 1 1v1h10.2a1 1 0 0 1 .8 1.6L15 8l2 2.4a1 1 0 0 1-.8 1.6H6v9a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Z"/>
</svg>`;

const normalizeFlagColors = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [...DEFAULT_FLAG_COLORS];
  }

  const unique = new Set<string>();
  value.forEach((item) => {
    if (typeof item !== 'string') {
      return;
    }

    const color = item.trim().toLowerCase();
    if (!color) {
      return;
    }

    unique.add(color);
  });

  return unique.size > 0 ? Array.from(unique) : [...DEFAULT_FLAG_COLORS];
};

type ChromeStorageLocal = {
  get: (keys: string[], callback: (result: Record<string, unknown>) => void) => void;
  set: (items: Record<string, unknown>) => void;
};

const getChromeStorageLocal = () =>
  (globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: ChromeStorageLocal } };
  }).chrome?.storage?.local;

const loadFlagColors = () =>
  new Promise<string[]>((resolve) => {
    const storage = getChromeStorageLocal();
    if (!storage) {
      resolve([...DEFAULT_FLAG_COLORS]);
      return;
    }

    storage.get([FLAG_COLORS_STORAGE_KEY], (result) => {
      resolve(normalizeFlagColors(result?.[FLAG_COLORS_STORAGE_KEY]));
    });
  });

const saveFlagColors = (colors: string[]) => {
  const storage = getChromeStorageLocal();
  if (!storage) {
    return;
  }

  storage.set({ [FLAG_COLORS_STORAGE_KEY]: colors });
};

const getMessageCardKeyInfo = (
  messageCard: HTMLElement,
  options?: { includeTextFallback?: boolean }
): { preferredId: string | null; candidateIds: string[] } => {
  const includeTextFallback = options?.includeTextFallback ?? true;
  const candidates: string[] = [];
  const root = (messageCard.closest(MESSAGE_CARD_CONTAINER_SELECTOR) || messageCard) as HTMLElement;
  const item = root.closest('li') || root;

  const overlayCardId = root.id.match(/^overlay-conversation-card-(.+)$/)?.[1];
  if (overlayCardId) pushUnique(candidates, `overlay:${overlayCardId}`);

  // 1. Profile Key (The most stable ID)
  // Look in the card, his parents and children
  const profileAnchor = (
    root.querySelector('a[href*="/in/"]') ||
    item.querySelector('a[href*="/in/"]') ||
    (root.matches('a[href*="/in/"]') ? root : null)
  ) as HTMLAnchorElement | null;

  const profileHref = profileAnchor?.getAttribute('href')?.trim();
  if (profileHref) {
    try {
      const url = new URL(profileHref, window.location.origin);
      const match = url.pathname.match(/\/in\/([^/?#]+)/i);
      if (match?.[1]) {
        pushUnique(candidates, `profile:${match[1].toLowerCase()}`);
      }
    } catch {
      const match = profileHref.match(/\/in\/([^/?#]+)/i);
      if (match?.[1]) {
        pushUnique(candidates, `profile:${match[1].toLowerCase()}`);
      }
    }
  }

  // 2. Thread & Entity URNs
  const urnSources = [root, item, messageCard];
  const urnAttrs = ['data-occludable-entity-urn', 'data-entity-urn', 'data-id'];

  urnSources.forEach(src => {
    if (!src) return;
    urnAttrs.forEach(attr => {
      const val = src.getAttribute(attr)?.trim();
      if (val) {
        if (val.startsWith('urn:')) {
          pushUnique(candidates, normalizeUrnValue(val));
          pushUnique(candidates, val);
        } else {
          pushUnique(candidates, `id:${val}`);
        }
      }
    });
  });

  // 3. HREFs
  const hrefSources = [
    root,
    root.querySelector('a'),
    item.querySelector('a'),
    messageCard,
    (messageCard.matches('a') ? messageCard : null)
  ];

  hrefSources.forEach(src => {
    const href = src?.getAttribute('href')?.trim();
    if (href && !href.includes('ember')) {
      pushUnique(candidates, `href:${normalizeHrefValue(href)}`);
      pushUnique(candidates, `href:${href}`);
    }
  });

  // 4. NAME Fallback — use LinkedIn-specific `data-anonymize="person-name"` attribute
  // This is the ONLY element guaranteed to contain ONLY the person's raw name.
  // It will NEVER contain other text like injected badge text.
  if (includeTextFallback) {
    const nameSpan = (
      root.querySelector('[data-anonymize="person-name"]') ||
      item.querySelector('[data-anonymize="person-name"]') ||
      root.querySelector('.msg-conversation-listitem__participant-names span') ||
      item.querySelector('.msg-conversation-listitem__participant-names span') ||
      root.querySelector('.msg-conversation-card__participant-names span') ||
      item.querySelector('.msg-conversation-card__participant-names span')
    ) as HTMLElement | null;

    if (nameSpan) {
      // Grab the text content of this specific element only, not its children that might be injected
      let rawText = '';
      nameSpan.childNodes.forEach(node => {
        // Only read text nodes (not child elements like our badge spans)
        if (node.nodeType === Node.TEXT_NODE) {
          rawText += node.textContent || '';
        }
      });
      if (!rawText.trim()) {
        rawText = nameSpan.textContent || '';
      }
      const cleanName = rawText.replace(/\s+/g, ' ').trim().toLowerCase();
      if (cleanName && cleanName.length > 1) {
        pushUnique(candidates, `name:${cleanName}`);
      }
    }
  }

  return {
    preferredId: candidates.find(id => id.startsWith('profile:') || id.startsWith('name:')) || candidates[0] || null,
    candidateIds: candidates
  };
};

const getMessageCardIdCandidates = (
  messageCard: HTMLElement,
  options?: { includeTextFallback?: boolean }
) => getMessageCardKeyInfo(messageCard, options).candidateIds;

const getMessageCardId = (messageCard: HTMLElement): string | null => {
  const info = getMessageCardKeyInfo(messageCard, { includeTextFallback: true });
  return info.candidateIds.find(id => id.startsWith('name:') || id.startsWith('profile:')) || info.preferredId;
};


const resolveMessageCardElement = (element: HTMLElement | null) => {
  if (!element) {
    return null;
  }

  return element.closest(MESSAGE_CARD_SELECTOR) as HTMLElement | null;
};

const getConversationCards = () => {
  const shadowRoot = document.querySelector(INTEROP_OUTLET_SELECTOR)?.shadowRoot;
  return shadowRoot ? Array.from(shadowRoot.querySelectorAll<HTMLElement>(MESSAGE_CARD_SELECTOR)) : [];
};

const setCardRole = (messageCard: HTMLElement, role: string) => {
  const cardId = getMessageCardId(messageCard);
  if (!cardId) return;

  const current = cardTags[cardId] || {};
  let roles = Array.isArray(current.roles) ? current.roles : (current.role ? [current.role] : []);
  roles = roles.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim());

  const targetRole = role.trim();
  const isPresent = roles.includes(targetRole);

  let nextRoles: string[];
  if (isPresent) {
    nextRoles = roles.filter(r => r !== targetRole);
  } else {
    nextRoles = [...roles, targetRole].slice(-2);
  }

  cardTags[cardId] = { ...current, roles: nextRoles, role: nextRoles[0] || '' };
  saveCardTags(cardTags);
};

const setCardFlag = (messageCard: HTMLElement, flagColor: string) => {
  const cardId = getMessageCardId(messageCard);
  if (!cardId) return;
  cardTags[cardId] = { ...cardTags[cardId], flagColor };
  saveCardTags(cardTags); // ← ADD KARO
};

const normalizeCardTags = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {} as Record<string, CardTag>;
  }

  const normalized: Record<string, CardTag> = {};
  Object.entries(value as Record<string, unknown>).forEach(([key, rawTag]) => {
    if (!rawTag || typeof rawTag !== 'object' || Array.isArray(rawTag)) {
      return;
    }

    const rawTagRecord = rawTag as { role?: unknown; roles?: unknown; flagColor?: unknown };
    const role = typeof rawTagRecord.role === 'string' ? rawTagRecord.role.trim() : '';
    const roles = Array.isArray(rawTagRecord.roles)
      ? Array.from(
        new Set(
          rawTagRecord.roles
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      ).slice(0, 2)
      : [];
    const flagColor = typeof rawTagRecord.flagColor === 'string' ? rawTagRecord.flagColor.trim().toLowerCase() : '';

    const mergedRoles = Array.from(new Set([...roles, ...(role ? [role] : [])])).slice(0, 2);
    if (mergedRoles.length === 0 && !flagColor) return;

    let normalizedKey =
      key.startsWith('urn:')
        ? normalizeUrnValue(key)
        : key.startsWith('href:')
          ? `href:${normalizeHrefValue(key.slice(5))}`
          : key.startsWith('profile:')
            ? `profile:${key.slice(8).toLowerCase().trim()}`
            : key.trim();

    // AUTO-HEAL: Convert old 'text:' keys to 'name:' and strip any accidental role text
    if (normalizedKey.startsWith('text:') || normalizedKey.startsWith('name:')) {
      const badPhrases = ['web developer', 'app developer', 'full stack developer', 'ui/ux designer', 'ai developer', 'software tester'];
      let keyVal = normalizedKey.startsWith('text:') ? normalizedKey.slice(5) : normalizedKey.slice(5);
      badPhrases.forEach(phrase => {
        keyVal = keyVal.replace(phrase, '').trim();
      });
      normalizedKey = `name:${keyVal.trim()}`;
    }

    if (!normalizedKey) {
      return;
    }

    normalized[normalizedKey] = {
      ...normalized[normalizedKey],
      ...(mergedRoles.length ? { roles: mergedRoles, role: mergedRoles[0] } : {}),
      ...(flagColor ? { flagColor } : {})
    };
  });

  return normalized;
};

const loadCardTags = () =>
  new Promise<Record<string, CardTag>>((resolve) => {
    if (!chrome.storage?.local) {
      resolve({});
      return;
    }

    chrome.storage.local.get([CARD_TAGS_STORAGE_KEY], (result) => {
      resolve(normalizeCardTags(result?.[CARD_TAGS_STORAGE_KEY]));
    });
  });

const saveCardTags = (nextTags: Record<string, CardTag>) =>
  new Promise<string | null>((resolve) => {
    if (!chrome.storage?.local) {
      resolve(null);
      return;
    }

    // Merge with existing storage to prevent data loss
    chrome.storage.local.get([CARD_TAGS_STORAGE_KEY], (result) => {
      const existing = normalizeCardTags(result?.[CARD_TAGS_STORAGE_KEY]);

      // Filter out fragile ember IDs from existing storage AND the incoming tags
      const cleanedExisting: Record<string, CardTag> = {};
      Object.keys(existing).forEach(key => {
        if (!key.includes('ember')) {
          cleanedExisting[key] = existing[key];
        }
      });

      const cleanedNext: Record<string, CardTag> = {};
      Object.keys(nextTags).forEach(key => {
        if (!key.includes('ember')) {
          cleanedNext[key] = nextTags[key];
        }
      });

      const merged = { ...cleanedExisting, ...cleanedNext };

      chrome.storage?.local?.set({ [CARD_TAGS_STORAGE_KEY]: merged }, () => {
        resolve(chrome.runtime.lastError?.message ?? null);
      });
    });
  });


const clearCardTags = () =>
  new Promise<void>((resolve) => {
    if (!chrome.storage?.local) {
      resolve();
      return;
    }

    chrome.storage.local.remove([CARD_TAGS_STORAGE_KEY], () => resolve());
  });

let applyStoredTagsTimer: ReturnType<typeof setTimeout> | null = null;
let lastApplyTime = 0;

const scheduleApplyStoredTags = (delayMs = 250) => {
  const now = Date.now();
  // If it's been more than 2 seconds since last apply, apply immediately
  if (now - lastApplyTime > 2000) {
    if (applyStoredTagsTimer) clearTimeout(applyStoredTagsTimer);
    applyStoredTagsToVisibleCards();
    lastApplyTime = now;
    return;
  }

  if (applyStoredTagsTimer) {
    clearTimeout(applyStoredTagsTimer);
  }

  applyStoredTagsTimer = setTimeout(() => {
    applyStoredTagsToVisibleCards();
    lastApplyTime = Date.now();
  }, delayMs);
};

// Robust fallback: Force an injection check every 2 seconds no matter what.
setInterval(() => {
  if (Object.keys(cardTags).length > 0) {
    scheduleApplyStoredTags(0);
  }
}, 2000);


const removeCardBadges = (messageCard: HTMLElement) => {
  const roleRow = messageCard.querySelector(`.${ROLE_BADGE_ROW_CLASS}`);
  if (roleRow) {
    roleRow.remove();
  }

  const flagBadge = messageCard.querySelector(`.${FLAG_BADGE_CLASS}`);
  if (flagBadge) {
    flagBadge.remove();
  }
};

const applyStoredTagsToVisibleCards = () => {
  const seenCardIds = new Set<string>();
  let matchedTagCount = 0;
  let injectedCount = 0;
  const cards = getConversationCards();

  cards.forEach((card) => {
    const resolvedCard = card;

    const candidateIds = getMessageCardIdCandidates(resolvedCard);

    if (candidateIds.length === 0) return;

    // Use a very stable field for the 'seen' check to avoid duplicates while allowing retries
    const stabilityKey = candidateIds.find(id => id.startsWith('overlay:')) || candidateIds.find(id => id.startsWith('profile:')) || candidateIds[0];
    if (seenCardIds.has(stabilityKey)) {
      return;
    }
    seenCardIds.add(stabilityKey);

    let matchedCardId = candidateIds.find((id) => {
      const hasTag = Boolean(cardTags[id]);
      if (hasTag) console.log(`[LinkedIn Ext] Exact matched card ${stabilityKey} with ID ${id}`);
      return hasTag;
    }) ?? null;

    // Fuzzy Match Fallback: If no exact match, try to see if any storage key PARTIALLY matches our text fallback (or vice versa)
    // This is a safety net for lingering corrupted tags like "text:muhammad samad app developer"
    if (!matchedCardId) {
      const textCandidate = candidateIds.find(id => id.startsWith('name:') || id.startsWith('text:'));
      if (textCandidate) {
        const rawTextName = textCandidate.replace(/^(?:name|text):/, '').trim();
        if (rawTextName.length > 5) { // Ensure name is reasonably long to avoid false positives
          const storageKeys = Object.keys(cardTags);
          matchedCardId = storageKeys.find(key => {
            if (key.startsWith('text:') || key.startsWith('name:')) {
              const rawStorageName = key.replace(/^(?:name|text):/, '').trim();
              // Check if storage key contains visual name, or visual name contains storage key
              if (rawStorageName.includes(rawTextName) || rawTextName.includes(rawStorageName)) {
                console.log(`[LinkedIn Ext] Fuzzy matched card ${textCandidate} with storage key ${key}`);
                return true;
              }
            }
            return false;
          }) || null;
        }
      }
    }

    const tag = matchedCardId ? cardTags[matchedCardId] : null;

    // --- Filtering Logic ---
    const cardContainer = (card.closest(MESSAGE_CARD_CONTAINER_SELECTOR) || card) as HTMLElement;
    if (currentFilterQuery.trim()) {
      const query = currentFilterQuery.toLowerCase().trim();
      const roles = tag ? (Array.isArray(tag.roles) ? tag.roles : (tag.role ? [tag.role] : [])) : [];
      const hasMatch = roles.some(role => role.toLowerCase().includes(query));

      if (!hasMatch) {
        cardContainer.style.display = 'none';
        return; // Don't inject badges if hidden
      } else {
        cardContainer.style.display = '';
      }
    } else {
      cardContainer.style.display = '';
    }
    // ------------------------

    // Always ensure old role badges are gone before re-applying to reflect removals/toggles
    const roleRow = resolvedCard.querySelector(`.${ROLE_BADGE_ROW_CLASS}`);
    if (roleRow) roleRow.remove();

    if (!tag) return;

    const roles = Array.isArray(tag.roles) ? tag.roles : (tag.role ? [tag.role] : []);
    const validRoles = Array.from(new Set(roles.filter(r => typeof r === 'string' && r.trim()))).slice(0, 2);

    if (validRoles.length === 0 && !tag.flagColor) return;
    matchedTagCount += 1;

    validRoles.forEach((roleValue) => {
      injectRoleIntoCard(resolvedCard, roleValue);
      injectedCount += 1;
    });

    if (tag.flagColor) {
      injectFlagIntoCard(resolvedCard, tag.flagColor);
      injectedCount += 1;
    }
  });

  return {
    visibleCards: seenCardIds.size,
    matchedTags: matchedTagCount,
    injectedBadges: injectedCount,
    debugStorageKeys: Object.keys(cardTags).slice(0, 3).join(' | '),
    debugFoundKeys: Array.from(seenCardIds).slice(0, 3).join(' | ')
  };
};

const injectFlagIntoCard = (messageCard: HTMLElement, color: string) => {
  const computed = window.getComputedStyle(messageCard);

  if (computed.position === 'static') {
    messageCard.style.position = 'relative';
  }

  let flagBadge = messageCard.querySelector(`.${FLAG_BADGE_CLASS}`) as HTMLElement | null;

  if (!flagBadge) {
    flagBadge = document.createElement('span');
    flagBadge.className = FLAG_BADGE_CLASS;
    flagBadge.style.position = 'absolute';
    flagBadge.style.top = 'calc(50% + 2px)';
    flagBadge.style.left = '12px';
    flagBadge.style.transform = 'translateY(-50%)';
    flagBadge.style.zIndex = '1001';
    flagBadge.style.pointerEvents = 'none';
    flagBadge.style.display = 'inline-flex';
    flagBadge.style.alignItems = 'center';
    flagBadge.style.justifyContent = 'center';
    flagBadge.style.width = '40px';
    flagBadge.style.height = '40px';
    // flagBadge.style.border = '1px solid #0a66c2';
    flagBadge.style.borderRadius = '50%';
    // flagBadge.style.padding='1px'
    flagBadge.style.background = '#ffffff';
    messageCard.appendChild(flagBadge);
  }

  flagBadge.innerHTML = createFlagSvg(color, 32);
};

const injectRoleIntoCard = (messageCard: HTMLElement, role: string) => {
  // Try to find a good anchor point for the badge
  const target =
    messageCard.querySelector('.msg-conversation-listitem__participant-names') ||
    messageCard.querySelector('.msg-conversation-card__participant-names') ||
    messageCard.querySelector('.msg-conversation-listitem__meta') ||
    messageCard;

  let badgeRow = (target as HTMLElement).querySelector(`.${ROLE_BADGE_ROW_CLASS}`) as HTMLElement | null;
  const existingLeftBadge = (target as HTMLElement).querySelector(`.${ROLE_BADGE_LEFT_CLASS}`) as HTMLElement | null;
  const existingRightBadge = (target as HTMLElement).querySelector(`.${ROLE_BADGE_RIGHT_CLASS}`) as HTMLElement | null;

  if (existingLeftBadge?.textContent === role || existingRightBadge?.textContent === role) {
    return;
  }

  if (!badgeRow) {
    (target as HTMLElement).style.overflow = 'visible';
    badgeRow = document.createElement('div');
    badgeRow.className = ROLE_BADGE_ROW_CLASS;
    badgeRow.style.display = 'flex';
    badgeRow.style.justifyContent = 'space-between';
    badgeRow.style.alignItems = 'center';
    badgeRow.style.width = '100%';
    badgeRow.style.position = 'absolute';
    badgeRow.style.top = '2px';
    badgeRow.style.left = '0';
    badgeRow.style.right = '0';
    badgeRow.style.padding = '0 8px';
    badgeRow.style.zIndex = '1000';
    target.appendChild(badgeRow);
  }

  const createRoleBadge = (className: string, text: string, isRight: boolean) => {
    const badge = document.createElement('span');
    badge.className = `${ROLE_BADGE_CLASS} ${className}`;
    badge.textContent = text;
    badge.style.padding = '2px 8px';
    badge.style.borderRadius = '999px';
    badge.style.fontSize = '10px';
    badge.style.fontWeight = '700';

    if (isRight) {
      badge.style.background = '#fff5e8';
      badge.style.border = '1px solid #0a66c2';
      badge.style.color = '#0a66c2';
    } else {
      badge.style.background = '#e7f3ff';
      badge.style.border = '1px solid #0a66c2';
      badge.style.color = '#0a66c2';
    }

    return badge;
  };

  if (!existingLeftBadge) {
    badgeRow.appendChild(createRoleBadge(ROLE_BADGE_LEFT_CLASS, role, false));
    return;
  }

  if (!existingRightBadge) {
    badgeRow.appendChild(createRoleBadge(ROLE_BADGE_RIGHT_CLASS, role, true));
    return;
  }

  existingRightBadge.textContent = role;
};

const showRolePopup = (messageCard?: HTMLElement | null) => {
  // Do not auto-pick a card; only use an explicitly selected one.
  activeMessageCard = messageCard ?? activeMessageCard;

  const existing = document.getElementById(POPUP_ID);
  if (existing) {
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = POPUP_ID;
  overlay.style.position = 'fixed';
  overlay.style.left = '50%';
  overlay.style.top = '50%';
  overlay.style.transform = 'translate(-50%, -50%)';
  overlay.style.zIndex = '2147483646';
  overlay.style.pointerEvents = 'none';

  const panel = document.createElement('div');
  panel.style.position = 'relative';
  panel.style.width = '352px';
  // panel.style.height = '400px';
  panel.style.background = '#ffffff';
  panel.style.borderRadius = '12px';
  panel.style.padding = '14px';
  panel.style.boxShadow = '0 12px 28px rgba(0, 0, 0, 0.22)';
  panel.style.fontFamily = 'Segoe UI, sans-serif';
  panel.style.pointerEvents = 'auto';

  const header = document.createElement('div');
  header.style.display = 'flex';
  header.style.alignItems = 'center';
  header.style.gap = '10px';
  header.style.margin = '-14px -14px 12px -14px';
  header.style.padding = '14px';
  header.style.background = 'linear-gradient(135deg, #0a66c2 0%, #0d80f2 100%)';

  const linkedInLogo = document.createElement('div');
  linkedInLogo.style.width = '28px';
  linkedInLogo.style.height = '28px';
  linkedInLogo.style.display = 'flex';
  linkedInLogo.style.alignItems = 'center';
  linkedInLogo.style.justifyContent = 'center';
  linkedInLogo.innerHTML =
    '<svg width="28" height="28" viewBox="0 0 34 34" aria-hidden="true"><rect width="34" height="34" rx="6" fill="#0A66C2"/><path d="M10.7 13.2h3.9V25h-3.9V13.2Zm1.9-6.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Zm4.5 6.2h3.8v1.6h.1c.5-1 1.8-2 3.8-2 4.1 0 4.9 2.6 4.9 6.1V25h-3.9v-5.1c0-1.3 0-2.9-1.8-2.9-1.8 0-2.1 1.4-2.1 2.8V25h-3.9V13.2Z" fill="#ffffff"/></svg>';


  const crossbutton = document.createElement('button');
  crossbutton.type = 'button';
  crossbutton.textContent = '\u00D7';
  crossbutton.setAttribute('aria-label', 'Close popup');
  crossbutton.style.fontSize = '25px';
  crossbutton.style.lineHeight = '1';
  crossbutton.style.color = '#ffffff';
  crossbutton.style.cursor = 'pointer';
  crossbutton.style.marginLeft = 'auto';
  crossbutton.style.width = '28px';
  crossbutton.style.height = '28px';
  crossbutton.style.display = 'inline-flex';
  crossbutton.style.alignItems = 'center';
  crossbutton.style.justifyContent = 'center';
  crossbutton.style.border = 'none';
  crossbutton.style.background = 'transparent';
  crossbutton.style.padding = '0';
  crossbutton.onclick = () => overlay.remove();
  

  const title = document.createElement('h3');
  title.textContent = 'Developer Tagger';
  title.style.margin = '0';
  title.style.fontSize = '16px';
  title.style.color = '#ffffff';

  

  header.appendChild(linkedInLogo);
  header.appendChild(title);
  header.appendChild(crossbutton);
  panel.appendChild(header);

  const rolemove = document.createElement('div');
  rolemove.style.display = 'flex';
  rolemove.style.justifyContent = 'space-around';
  rolemove.style.alignItems = 'center';
  rolemove.style.gap = '0';
  rolemove.style.fontSize = '16px';
  rolemove.style.lineHeight = '1.4';
  rolemove.style.color = '#1f2328';
  rolemove.style.borderBottom = '2px solid #e8eef6';
  rolemove.style.marginBottom = '22px';


  const roleNavRow = document.createElement('div');
  roleNavRow.style.display = 'flex';
  roleNavRow.style.alignItems = 'center';
  roleNavRow.style.gap = '8px';
  roleNavRow.style.marginBottom = '10px';




  let flagColors = [...DEFAULT_FLAG_COLORS];

  const text1 = document.createElement('span');
  text1.textContent = 'Select Role:';
  text1.style.fontWeight = '500';
  text1.style.cursor = 'pointer';
  text1.style.padding = '6px 0 12px 0';
  text1.style.borderBottom = '3px solid transparent';

  text1.onclick = () => {
    buttonWrap.style.display = 'flex';
    flagRow.style.display = 'none';
    addFlagWrap.style.display = 'none';
    setActiveTab('role');
  };

  const renderFlags = () => {
    flagRow.innerHTML = '';

    flagColors.forEach((color) => {
      const flagItem = document.createElement('div');
      flagItem.style.position = 'relative';
      flagItem.style.width = '72px';
      flagItem.style.height = '72px';
      flagItem.style.display = 'flex';
      flagItem.style.alignItems = 'center';
      flagItem.style.justifyContent = 'center';

      const flag = document.createElement('span');
      flag.className = 'flag-icon';
      flag.style.display = 'inline-flex';
      flag.style.alignItems = 'center';
      flag.style.justifyContent = 'center';
      flag.style.width = '68px';
      flag.style.height = '68px';
      flag.style.border = '3px solid #0a66c2';
      flag.style.borderRadius = '50%';
      flag.style.padding = '4px';
      flag.style.cursor = 'pointer';
      flag.innerHTML = createFlagSvg(color, 42);
      flag.onclick = () => {
        if (!activeMessageCard) {
          return;
        }
        // CRITICAL: Must save to storage BEFORE injecting to avoid DOM contamination
        setCardFlag(activeMessageCard, color);
        injectFlagIntoCard(activeMessageCard, color);
      };

      const deleteButton = document.createElement('button');
      deleteButton.type = 'button';
      deleteButton.textContent = 'x';
      deleteButton.style.position = 'absolute';
      deleteButton.style.top = '0';
      deleteButton.style.right = '0';
      deleteButton.style.width = '20px';
      deleteButton.style.height = '20px';
      deleteButton.style.border = '1px solid #d0d7de';
      deleteButton.style.borderRadius = '50%';
      deleteButton.style.background = '#ffffff';
      deleteButton.style.color = '#1f2328';
      deleteButton.style.cursor = 'pointer';
      deleteButton.style.display = 'flex';
      deleteButton.style.alignItems = 'center';
      deleteButton.style.justifyContent = 'center';
      deleteButton.style.padding = '0';
      deleteButton.style.lineHeight = '1';
      deleteButton.style.fontWeight = '700';
      deleteButton.onclick = (event) => {
        event.stopPropagation();
        const colorIndex = flagColors.indexOf(color);
        if (colorIndex === -1) {
          return;
        }

        flagColors.splice(colorIndex, 1);
        renderFlags();
        saveFlagColors(flagColors);
      };

      flagItem.appendChild(flag);
      flagItem.appendChild(deleteButton);
      flagRow.appendChild(flagItem);
    });
  };

  const text2 = document.createElement('span');
  text2.textContent = 'Flag';
  text2.style.fontWeight = '700';
  text2.style.cursor = 'pointer';
  text2.style.padding = '6px 0 12px 0';
  text2.style.borderBottom = '3px solid transparent';
  const setActiveTab = (tab: 'role' | 'flag') => {
    const isRole = tab === 'role';
    text1.style.borderBottom = isRole ? '3px solid #0a66c2' : '3px solid transparent';
    text1.style.color = isRole ? '#0a66c2' : '#9aa6b2';
    text2.style.borderBottom = isRole ? '3px solid transparent' : '3px solid #0a66c2';
    text2.style.color = isRole ? '#9aa6b2' : '#0a66c2';
  };
  text2.onclick = () => {
    renderFlags();
    flagRow.style.display = 'grid';
    addFlagWrap.style.display = 'flex';
    buttonWrap.style.display = 'none';
    setActiveTab('flag');
  };

  rolemove.appendChild(text1);
  rolemove.appendChild(text2);
  panel.appendChild(rolemove);
  setActiveTab('role');

  const flagRow = document.createElement('div');
  flagRow.style.display = 'none';
  flagRow.style.width = '100%';
  flagRow.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
  flagRow.style.justifyItems = 'center';
  flagRow.style.alignItems = 'center';
  flagRow.style.gap = '12px';
  flagRow.style.marginBottom = '10px';
  panel.appendChild(flagRow);

  const addFlagWrap = document.createElement('div');
  addFlagWrap.style.display = 'none';
  addFlagWrap.style.width = '100%';
  addFlagWrap.style.alignItems = 'center';
  addFlagWrap.style.gap = '8px';
  addFlagWrap.style.marginBottom = '10px';

  const customColorInput = document.createElement('input');
  customColorInput.type = 'color';
  customColorInput.value = '#00aa00';
  customColorInput.style.width = '44px';
  customColorInput.style.height = '36px';
  customColorInput.style.border = '1px solid #d0d7de';
  customColorInput.style.borderRadius = '8px';
  customColorInput.style.background = '#ffffff';
  customColorInput.style.cursor = 'pointer';

  const createFlagButton = document.createElement('button');
  createFlagButton.textContent = 'Create Flag';
  createFlagButton.style.flex = '1';
  createFlagButton.style.padding = '8px 12px';
  createFlagButton.style.border = '1px solid #d0d7de';
  createFlagButton.style.borderRadius = '8px';
  createFlagButton.style.background = '#ffffff';
  createFlagButton.style.color = '#1f2328';
  createFlagButton.style.fontWeight = '700';
  createFlagButton.style.cursor = 'pointer';
  createFlagButton.onclick = () => {
    const newColor = customColorInput.value.trim().toLowerCase();
    if (!newColor || flagColors.includes(newColor)) {
      return;
    }

    flagColors.push(newColor);
    renderFlags();
    saveFlagColors(flagColors);
  };

  addFlagWrap.appendChild(customColorInput);
  addFlagWrap.appendChild(createFlagButton);
  panel.appendChild(addFlagWrap);

  loadFlagColors().then((storedColors) => {
    flagColors = storedColors;
    if (flagRow.style.display === 'grid') {
      renderFlags();
    }
  });

  const noactivecard = document.createElement('span');
  noactivecard.textContent = 'No active card found';
  noactivecard.style.display = 'block';
  noactivecard.style.margin = '0 0 12px 8px';
  noactivecard.style.padding = '0';
  noactivecard.style.color = '#9aa6b2';
  noactivecard.style.fontSize = '16px';
  noactivecard.style.display='none'
  panel.appendChild(noactivecard);

  const buttonWrap = document.createElement('div');
  buttonWrap.style.display = 'flex';
  buttonWrap.style.flexWrap = 'wrap';
  buttonWrap.style.gap = '10px';
  buttonWrap.style.marginBottom = '12px';
  panel.appendChild(buttonWrap);
  

 

  ['Web Developer', 'App Developer', 'Full Stack Developer', 'UI/UX Designer', 'AI Developer', 'Software Tester'].forEach((role) => {
    const button = document.createElement('button');
    button.textContent = role;
    button.style.width = 'calc(50% - 5px)';
    button.style.padding = '10px 12px';
    button.style.border = 'none';
    button.style.borderRadius = '8px';
    button.style.background = '#0a66c2';
    button.style.color = '#ffffff';
    button.style.fontWeight = '700';
    button.style.cursor = 'pointer';
    button.onclick = () => {
      if (!activeMessageCard) {
        noactivecard.style.display='block'
        return;
      }
      // CRITICAL: Must save to storage BEFORE injecting to avoid DOM contamination
    noactivecard.style.display='none';
      setCardRole(activeMessageCard, role);
      injectRoleIntoCard(activeMessageCard, role);
    };

    buttonWrap.appendChild(button);
  });

  const close = document.createElement('button');
  close.textContent = 'Close';
  close.style.width = '100%';
  close.style.padding = '9px 12px';
  close.style.border = '1px solid #d0d7de';
  close.style.borderRadius = '8px';
  close.style.background = '#ffffff';
  close.style.color = '#1f2328';
  close.style.cursor = 'pointer';
  close.onclick = () => overlay.remove();
  panel.appendChild(close);

  overlay.appendChild(panel);
  document.body.appendChild(overlay);
};


document.addEventListener('click', (event) => {
  const path = event.composedPath();
  const target = path.find((node): node is HTMLElement => node instanceof HTMLElement && node.matches(MESSAGE_CARD_SELECTOR));
  const messageCard = target || resolveMessageCardElement(event.target as HTMLElement | null);

  if (!messageCard) {
    return;
  }

  activeMessageCard = messageCard;
  scheduleApplyStoredTags(0);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'SHOW_DEV_ROLE_POPUP') {
    showRolePopup();
  }

  if (message?.type === 'FILTER_PROFILES') {
    currentFilterQuery = message.query || '';
    applyStoredTagsToVisibleCards();
  }

  if (message?.type === 'SAVE_CARD_TAGS') {
    saveCardTags(cardTags).then((error) => {
      if (error) {
        chrome.runtime.sendMessage({
          type: 'CARD_TAGS_STATUS',
          status: 'failed',
          error
        });
        return;
      }

      chrome.runtime.sendMessage({
        type: 'CARD_TAGS_STATUS',
        status: 'saved',
        count: Object.keys(cardTags).length
      });
    });
  }

  if (message?.type === 'CLEAR_CARD_TAGS') {
    cardTags = {};
    clearCardTags().then(() => {
      const cards = getConversationCards();
      cards.forEach(removeCardBadges);

      chrome.runtime.sendMessage({
        type: 'CARD_TAGS_STATUS',
        status: 'cleared',
        count: 0
      });
    });
  }
});

// ✅ Cross-tab synchronization
chrome.storage?.onChanged?.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[CARD_TAGS_STORAGE_KEY]) {
    const newVal = normalizeCardTags(changes[CARD_TAGS_STORAGE_KEY].newValue);
    cardTags = { ...cardTags, ...newVal };
    scheduleApplyStoredTags(100);
  }
});


// ✅ FIX 2: Page load pe delay add karo
loadCardTags().then((storedTags) => {
  cardTags = storedTags;
  applyStoredTagsToVisibleCards();
  [700, 1600, 3200, 5200].forEach((delayMs) => {
    setTimeout(() => scheduleApplyStoredTags(0), delayMs);
  });
});

const observer = new MutationObserver(() => {
  scheduleApplyStoredTags(350);
});
observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'href', 'data-occludable-entity-urn', 'data-entity-urn', 'aria-current']
});

let observedConversationRoot: ShadowRoot | null = null;
const observeConversationRoot = () => {
  const shadowRoot = document.querySelector(INTEROP_OUTLET_SELECTOR)?.shadowRoot;
  if (!shadowRoot || shadowRoot === observedConversationRoot) return;
  observedConversationRoot = shadowRoot;
  observer.observe(shadowRoot, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['id', 'class', 'href', 'data-occludable-entity-urn', 'data-entity-urn', 'aria-current']
  });
  scheduleApplyStoredTags(0);
};
observeConversationRoot();
const interopObserver = new MutationObserver(observeConversationRoot);
interopObserver.observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener(
  'scroll',
  () => {
    scheduleApplyStoredTags(350);
  },
  { passive: true, capture: true }
);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    scheduleApplyStoredTags(100);
  }
});
