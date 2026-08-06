/**
 * LRU Cache - Shared cache utility for video backends
 *
 * Provides a size-limited cache with least-recently-used eviction.
 * Used by both HDF5VideoBackend and MediaVideoBackend for frame caching.
 */

class LRUCache {
    /**
     * Create an LRU cache
     * @param {number} maxSize - Maximum number of entries
     * @param {Function} [onEvict] - Callback(key, value) when entry is evicted
     */
    constructor(maxSize, onEvict = null) {
        this._maxSize = maxSize;
        this._onEvict = onEvict;
        this._cache = new Map();
    }

    /**
     * Get maximum cache size
     * @type {number}
     */
    get maxSize() {
        return this._maxSize;
    }

    /**
     * Set maximum cache size (evicts if needed)
     * @param {number} size
     */
    set maxSize(size) {
        this._maxSize = size;
        this._evictIfNeeded();
    }

    /**
     * Get current number of entries
     * @type {number}
     */
    get size() {
        return this._cache.size;
    }

    /**
     * Check if key exists
     * @param {*} key
     * @returns {boolean}
     */
    has(key) {
        return this._cache.has(key);
    }

    /**
     * Get value for key (updates recency)
     * @param {*} key
     * @returns {*} Value or undefined
     */
    get(key) {
        if (!this._cache.has(key)) {
            return undefined;
        }
        // Move to end (most recently used)
        const value = this._cache.get(key);
        this._cache.delete(key);
        this._cache.set(key, value);
        return value;
    }

    /**
     * Get value without updating recency (peek)
     * @param {*} key
     * @returns {*} Value or undefined
     */
    peek(key) {
        return this._cache.get(key);
    }

    /**
     * Set key-value pair (evicts oldest if at capacity)
     * @param {*} key
     * @param {*} value
     */
    set(key, value) {
        // If key exists, delete first to update position
        if (this._cache.has(key)) {
            this._cache.delete(key);
        }

        this._cache.set(key, value);
        this._evictIfNeeded();
    }

    /**
     * Delete a key
     * @param {*} key
     * @returns {boolean} True if key existed
     */
    delete(key) {
        if (this._cache.has(key)) {
            const value = this._cache.get(key);
            this._cache.delete(key);
            if (this._onEvict) {
                this._onEvict(key, value);
            }
            return true;
        }
        return false;
    }

    /**
     * Clear all entries
     */
    clear() {
        if (this._onEvict) {
            for (const [key, value] of this._cache) {
                this._onEvict(key, value);
            }
        }
        this._cache.clear();
    }

    /**
     * Get all keys (oldest first)
     * @returns {Iterator}
     */
    keys() {
        return this._cache.keys();
    }

    /**
     * Get all values (oldest first)
     * @returns {Iterator}
     */
    values() {
        return this._cache.values();
    }

    /**
     * Get all entries (oldest first)
     * @returns {Iterator}
     */
    entries() {
        return this._cache.entries();
    }

    /**
     * Evict oldest entries until under max size
     * @private
     */
    _evictIfNeeded() {
        while (this._cache.size > this._maxSize) {
            const oldestKey = this._cache.keys().next().value;
            const oldestValue = this._cache.get(oldestKey);
            this._cache.delete(oldestKey);
            if (this._onEvict) {
                this._onEvict(oldestKey, oldestValue);
            }
        }
    }
}

// Export for different module systems
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { LRUCache };
} else if (typeof window !== 'undefined') {
    window.LRUCache = LRUCache;
}
