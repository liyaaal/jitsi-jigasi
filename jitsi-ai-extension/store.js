/* IndexedDB stores blobs, not base64 strings or public-page localStorage. */
globalThis.MeetingStore = (() => {
    const database = new Promise((resolve, reject) => {
        const request = indexedDB.open('meeting-pro', 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore('sessions', { keyPath: 'id' });
            const segments = request.result.createObjectStore('segments', { keyPath: 'id' });
            segments.createIndex('sessionId', 'sessionId');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    async function transaction(stores, mode, operation) {
        const db = await database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(stores, mode);
            const request = operation(tx);
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Сохранение отменено.'));
        });
    }
    return {
        putSession: session => transaction(['sessions'], 'readwrite', tx => tx.objectStore('sessions').put(session)),
        listSessions: () => transaction(['sessions'], 'readonly', tx => tx.objectStore('sessions').getAll()),
        putSegment: segment => transaction(['segments'], 'readwrite', tx => tx.objectStore('segments').put(segment)),
        segments: sessionId => transaction(['segments'], 'readonly', tx => tx.objectStore('segments').index('sessionId').getAll(sessionId)),
        deleteSession: id => transaction(['sessions', 'segments'], 'readwrite', tx => {
            tx.objectStore('sessions').delete(id);
            const request = tx.objectStore('segments').index('sessionId').openCursor(IDBKeyRange.only(id));
            request.onsuccess = () => { const cursor = request.result; if (cursor) { cursor.delete(); cursor.continue(); } };
        })
    };
})();
