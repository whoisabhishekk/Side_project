// ============================================================
//  colorDB.js — IndexedDB Persistent Color History Storage
//  Stores every color result permanently in browser database
//  for backtesting, analysis, and cross-session persistence.
// ============================================================

const colorDB = (() => {
    const DB_NAME = 'ColorPredictionDB';
    const DB_VERSION = 1;
    const STORE_NAME = 'colors';

    let db = null;
    let _readyPromise = null;

    // ---- DB Initialization ----

    function init() {
        if (_readyPromise) return _readyPromise;

        _readyPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                console.warn('[colorDB] IndexedDB not supported in this browser');
                resolve(false);
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const database = event.target.result;

                if (!database.objectStoreNames.contains(STORE_NAME)) {
                    const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });

                    // Indexes for efficient querying
                    store.createIndex('by-category', 'category', { unique: false });
                    store.createIndex('by-period', 'period', { unique: false });
                    store.createIndex('by-timestamp', 'timestamp', { unique: false });
                    store.createIndex('by-cat-period', ['category', 'period'], { unique: true });
                }

                console.log('[colorDB] Database schema created/upgraded');
            };

            request.onsuccess = (event) => {
                db = event.target.result;

                // Handle DB close due to version change or other reasons
                db.onclose = () => {
                    console.warn('[colorDB] Database connection closed');
                    db = null;
                    _readyPromise = null;
                };

                db.onerror = (e) => {
                    console.error('[colorDB] Database error:', e.target.error);
                };

                console.log('[colorDB] Database ready');
                resolve(true);
            };

            request.onerror = (event) => {
                console.error('[colorDB] Failed to open database:', event.target.error);
                resolve(false);
            };

            request.onblocked = () => {
                console.warn('[colorDB] Database upgrade blocked — close other tabs');
            };
        });

        return _readyPromise;
    }

    // ---- Helper: Ensure DB is ready ----

    function ensureDB() {
        if (!db) {
            console.warn('[colorDB] Database not initialized. Call colorDB.init() first.');
            return false;
        }
        return true;
    }

    // ---- Build record from API period object ----

    function buildRecord(category, periodObj) {
        const period = periodObj.period;
        return {
            id: `${category}_${period}`,
            category: category,
            period: period,
            color: periodObj.is_green ? 'G' : 'R',
            isGreen: !!periodObj.is_green,
            isViolet: !!periodObj.is_violet,
            lastNum: periodObj.last_num ?? periodObj.number ?? null,
            timestamp: new Date().toISOString()
        };
    }

    // ---- Save single period (upsert / duplicate-safe) ----

    function savePeriod(category, periodObj) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve(false); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const record = buildRecord(category, periodObj);

                // put() = upsert (insert or update if key exists)
                const request = store.put(record);

                request.onsuccess = () => resolve(true);
                request.onerror = (e) => {
                    console.error('[colorDB] savePeriod error:', e.target.error);
                    resolve(false);
                };
            } catch (err) {
                console.error('[colorDB] savePeriod exception:', err);
                resolve(false);
            }
        });
    }

    // ---- Batch save periods (efficient single transaction) ----

    function savePeriods(category, periodsArray) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve(0); return; }
            if (!periodsArray || periodsArray.length === 0) { resolve(0); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                let savedCount = 0;

                periodsArray.forEach(periodObj => {
                    const record = buildRecord(category, periodObj);
                    const request = store.put(record);
                    request.onsuccess = () => { savedCount++; };
                    request.onerror = (e) => {
                        console.warn('[colorDB] Batch save skipped:', record.id, e.target.error);
                    };
                });

                tx.oncomplete = () => {
                    if (savedCount > 0) {
                        // Fire custom event for UI updates
                        window.dispatchEvent(new CustomEvent('colordb-updated', {
                            detail: { category, count: savedCount }
                        }));
                    }
                    resolve(savedCount);
                };

                tx.onerror = (e) => {
                    console.error('[colorDB] Batch transaction error:', e.target.error);
                    resolve(savedCount);
                };
            } catch (err) {
                console.error('[colorDB] savePeriods exception:', err);
                resolve(0);
            }
        });
    }

    // ---- Get all records for a category (newest first) ----

    function getByCategory(category, limit) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve([]); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('by-category');
                const request = index.getAll(IDBKeyRange.only(category));

                request.onsuccess = () => {
                    let results = request.result || [];
                    // Sort by period descending (newest first)
                    results.sort((a, b) => b.period - a.period);
                    if (limit && limit > 0) {
                        results = results.slice(0, limit);
                    }
                    resolve(results);
                };

                request.onerror = (e) => {
                    console.error('[colorDB] getByCategory error:', e.target.error);
                    resolve([]);
                };
            } catch (err) {
                console.error('[colorDB] getByCategory exception:', err);
                resolve([]);
            }
        });
    }

    // ---- Get records by date range (for backtesting) ----

    function getByDateRange(startDate, endDate, category) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve([]); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('by-timestamp');

                const startISO = startDate instanceof Date ? startDate.toISOString() : startDate;
                const endISO = endDate instanceof Date ? endDate.toISOString() : endDate;
                const range = IDBKeyRange.bound(startISO, endISO);

                const request = index.getAll(range);

                request.onsuccess = () => {
                    let results = request.result || [];
                    if (category) {
                        results = results.filter(r => r.category === category);
                    }
                    results.sort((a, b) => a.period - b.period);
                    resolve(results);
                };

                request.onerror = (e) => {
                    console.error('[colorDB] getByDateRange error:', e.target.error);
                    resolve([]);
                };
            } catch (err) {
                console.error('[colorDB] getByDateRange exception:', err);
                resolve([]);
            }
        });
    }

    // ---- Get all records ----

    function getAll(limit) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve([]); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.getAll();

                request.onsuccess = () => {
                    let results = request.result || [];
                    results.sort((a, b) => a.period - b.period);
                    if (limit && limit > 0) {
                        results = results.slice(0, limit);
                    }
                    resolve(results);
                };

                request.onerror = (e) => {
                    console.error('[colorDB] getAll error:', e.target.error);
                    resolve([]);
                };
            } catch (err) {
                console.error('[colorDB] getAll exception:', err);
                resolve([]);
            }
        });
    }

    // ---- Get total record count ----

    function getCount() {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve(0); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.count();

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(0);
            } catch (err) {
                resolve(0);
            }
        });
    }

    // ---- Get category-wise count ----

    function getCategoryCount(category) {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve(0); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('by-category');
                const request = index.count(IDBKeyRange.only(category));

                request.onsuccess = () => resolve(request.result);
                request.onerror = () => resolve(0);
            } catch (err) {
                resolve(0);
            }
        });
    }

    // ---- Get comprehensive stats ----

    async function getStats() {
        const stats = {
            total: 0,
            categories: { P: 0, S: 0, B: 0, E: 0 },
            oldestRecord: null,
            newestRecord: null
        };

        if (!ensureDB()) return stats;

        try {
            stats.total = await getCount();

            // Category counts
            for (const cat of ['P', 'S', 'B', 'E']) {
                stats.categories[cat] = await getCategoryCount(cat);
            }

            // Get oldest and newest records
            const allRecords = await getAll();
            if (allRecords.length > 0) {
                stats.oldestRecord = allRecords[0].timestamp;
                stats.newestRecord = allRecords[allRecords.length - 1].timestamp;
            }
        } catch (err) {
            console.error('[colorDB] getStats error:', err);
        }

        return stats;
    }

    // ---- Export all data as JSON (for backtesting) ----

    async function exportJSON() {
        const allData = await getAll();
        const stats = await getStats();

        // Compact format: recordFields + array-of-arrays (same as backtest_data.json)
        const recordFields = ['id', 'category', 'period', 'color', 'isGreen', 'isViolet', 'lastNum', 'timestamp'];
        const compactRecords = allData.map(r => [
            r.id,
            r.category,
            r.period,
            r.color,
            r.isGreen,
            !!r.isViolet,
            r.lastNum,
            r.timestamp
        ]);

        const exportObj = {
            exportDate: new Date().toISOString(),
            totalRecords: stats.total,
            categories: stats.categories,
            dateRange: {
                from: stats.oldestRecord,
                to: stats.newestRecord
            },
            recordFields: recordFields,
            records: compactRecords
        };

        // Trigger browser download
        const blob = new Blob([JSON.stringify(exportObj)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `backtest_data.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        return exportObj;
    }

    // ---- Import JSON data (for restoring backups) ----

    function importJSON(jsonData) {
        return new Promise(async (resolve, reject) => {
            if (!ensureDB()) { resolve(0); return; }

            try {
                let data;
                if (typeof jsonData === 'string') {
                    data = JSON.parse(jsonData);
                } else {
                    data = jsonData;
                }

                const records = data.records || data;
                if (!Array.isArray(records)) {
                    console.error('[colorDB] Import data must contain a records array');
                    resolve(0);
                    return;
                }

                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                let importedCount = 0;

                records.forEach(record => {
                    // Ensure record has required fields
                    if (record.id && record.category && record.period) {
                        const request = store.put(record);
                        request.onsuccess = () => { importedCount++; };
                    }
                });

                tx.oncomplete = () => {
                    window.dispatchEvent(new CustomEvent('colordb-updated', {
                        detail: { action: 'import', count: importedCount }
                    }));
                    resolve(importedCount);
                };

                tx.onerror = (e) => {
                    console.error('[colorDB] Import transaction error:', e.target.error);
                    resolve(importedCount);
                };
            } catch (err) {
                console.error('[colorDB] importJSON exception:', err);
                resolve(0);
            }
        });
    }

    // ---- Clear all data ----

    function clearAll() {
        return new Promise((resolve, reject) => {
            if (!ensureDB()) { resolve(false); return; }

            try {
                const tx = db.transaction(STORE_NAME, 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const request = store.clear();

                request.onsuccess = () => {
                    window.dispatchEvent(new CustomEvent('colordb-updated', {
                        detail: { action: 'clear' }
                    }));
                    console.log('[colorDB] All data cleared');
                    resolve(true);
                };

                request.onerror = (e) => {
                    console.error('[colorDB] clearAll error:', e.target.error);
                    resolve(false);
                };
            } catch (err) {
                console.error('[colorDB] clearAll exception:', err);
                resolve(false);
            }
        });
    }

    // ---- DB Status UI Controller ----

    function initStatusUI() {
        const statusEl = document.getElementById('db-status-bar');
        if (!statusEl) return;

        // Update stats on load and on every db change
        const updateUI = async () => {
            const stats = await getStats();
            const totalEl = document.getElementById('db-total-count');
            const catCountsEl = document.getElementById('db-cat-counts');
            const lastSyncEl = document.getElementById('db-last-sync');

            if (totalEl) {
                totalEl.textContent = stats.total.toLocaleString();
            }

            if (catCountsEl) {
                catCountsEl.innerHTML = ['P', 'S', 'B', 'E'].map(cat =>
                    `<span class="db-cat-chip db-cat-${cat.toLowerCase()}">${cat}: ${stats.categories[cat]}</span>`
                ).join('');
            }

            if (lastSyncEl && stats.newestRecord) {
                const d = new Date(stats.newestRecord);
                lastSyncEl.textContent = d.toLocaleTimeString('en-IN', {
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
            }
        };

        // Initial update
        updateUI();

        // Listen for DB changes
        window.addEventListener('colordb-updated', updateUI);

        // Export button
        const exportBtn = document.getElementById('db-export-btn');
        if (exportBtn) {
            exportBtn.addEventListener('click', async () => {
                exportBtn.disabled = true;
                exportBtn.textContent = '⏳ Exporting...';
                try {
                    const result = await exportJSON();
                    exportBtn.textContent = `✅ ${result.totalRecords} exported`;
                    setTimeout(() => {
                        exportBtn.textContent = '📥 Export';
                        exportBtn.disabled = false;
                    }, 2000);
                } catch (err) {
                    exportBtn.textContent = '❌ Error';
                    setTimeout(() => {
                        exportBtn.textContent = '📥 Export';
                        exportBtn.disabled = false;
                    }, 2000);
                }
            });
        }

        // Clear button
        const clearBtn = document.getElementById('db-clear-btn');
        if (clearBtn) {
            clearBtn.addEventListener('click', async () => {
                if (confirm('⚠️ Saara stored color data delete ho jaayega!\n\nAre you sure?')) {
                    await clearAll();
                    updateUI();
                }
            });
        }

        // Import via file input
        const importBtn = document.getElementById('db-import-btn');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json';
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    importBtn.disabled = true;
                    importBtn.textContent = '⏳ Importing...';
                    try {
                        const text = await file.text();
                        const count = await importJSON(text);
                        importBtn.textContent = `✅ ${count} imported`;
                        updateUI();
                        setTimeout(() => {
                            importBtn.textContent = '📤 Import';
                            importBtn.disabled = false;
                        }, 2000);
                    } catch (err) {
                        importBtn.textContent = '❌ Error';
                        setTimeout(() => {
                            importBtn.textContent = '📤 Import';
                            importBtn.disabled = false;
                        }, 2000);
                    }
                };
                input.click();
            });
        }
    }

    // ---- Public API ----

    return {
        init,
        savePeriod,
        savePeriods,
        getByCategory,
        getByDateRange,
        getAll,
        getCount,
        getCategoryCount,
        getStats,
        exportJSON,
        importJSON,
        clearAll,
        initStatusUI
    };
})();
