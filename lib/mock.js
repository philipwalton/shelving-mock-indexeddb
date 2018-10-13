/* eslint-disable max-len, require-jsdoc */

'use strict';
const {Event, EventTarget} = require('shelving-mock-event');

// Vars.
const connections = {}; // Open connections.
const versions = {}; // Highest database versions.
const storage = {}; // Root storage.

// IndexedDB classes.

// IDBFactory mock.
class IDBFactory {
  // Open a connection.
  open(name, version) {
    // Make a new request.
    // Set default handlers to ensure errors aren't masked by spotty implementations.
    const request = new IDBOpenDBRequest(name, version);

    // Watch out for: https://github.com/dhoulb/shelving-mock-indexeddb/issues/3
    request.onblocked = () => { throw new Error('IDBOpenDBRequest: Open database request was blocked because other connections could not be closed'); };
    return request;
  }

  // Delete a database.
  // Internally we regard 'opening a connection to a falsy/zero version' as a delete request.
  deleteDatabase(name) {
    // Make a new request.
    // Set default handlers to ensure errors aren't masked by spotty implementations.
    const request = new IDBOpenDBRequest(name, false);

    // Watch out for: https://github.com/dhoulb/shelving-mock-indexeddb/issues/3
    request.onblocked = () => { throw new Error('IDBOpenDBRequest: Open database request was blocked because other connections could not be closed'); };

    return request;
  }

  static cmp(a, b) {
    if (a < b) return -1;
    else if (a > b) return 1;
    else return 0;
  }
}

// IDBDatabase database connection mock.
class IDBDatabase extends EventTarget {
  // Construct.
  constructor(name, version, data) {
    // Check params.
    if (!validIdentifier(name)) {
      throw new TypeError('IDBDatabase: dbName must be a valid identifier');
    }
    if (!validVersion(version)) {
      throw new TypeError('IDBDatabase: version must be a valid version');
    }
    if (!(data instanceof Object)) {
      throw new TypeError('IDBDatabase: data must be an object');
    }
    if (data.constructor !== Object) {
      throw new TypeError('IDBDatabase: data must be a plain object');
    }

    // EventTarget.
    // 'upgradeneeded' events require all other connections to the database to be closed in order to run.
    // So 'versionchange' is called on this connection to alert us that it needs to be closed.
    // This usually happens in a different tab/window (i.e. the the user opened a new tab that reloaded the schema from the server and the database now needs an updated schema).
    // 'versionchange' must close this connection or the connection in the other tab will be blocked (e.g. 'block' will be fired on the IDBOpenDBRequest).
    // e.g. either call `this.close` or do a `window.location = window.location` to refresh the page.
    super(null, ['abort', 'error', 'versionchange', 'close']);

    this._name = name;
    this._version = version;

    // this._data = data;
    Object.defineProperty(this, '_data', {
      get() {
        if (this._closed) {
          throw new Error('IDBDatabase: _data cannot be accessed after connection has closed');
        }
        return data;
      },
    });

    // Vars.
    this._queue = []; // Secret transaction queue for this database.
    this._closed = false; // closed flag.
    this._closing = false; // closing flag.
    this._active = null; // Active transaction.
    this._timeout = null; // Run timeout.

    // Add this to list of open connections.
    if (!connections[name]) connections[name] = [];
    connections[name].push(this);
  }

  // Properties.
  get name() {
    return this._name;
  }

  get version() {
    return this._version;
  }

  get objectStoreNames() {
    const names = Object.keys(this._data);
    names.sort();
    // Fake contains from DOMStringList
    names.contains = (valueTest) => names.indexOf(valueTest) !== -1;
    return names;
  }

  // Throw errors by default if this isn't overridden.
  onerror(err) {
    throw err;
  }

  // Create a transaction on this database that accesses one or more stores.
  transaction(storeNames, mode) {
    // Check params.
    if (typeof storeNames === 'string') storeNames = [storeNames];
    if (!(storeNames instanceof Array)) {
      throw new TypeError('IDBDatabase.transaction(): storeNames must be string or array');
    }
    if (!storeNames.length) {
      throw new TypeError('IDBDatabase.transaction(): storeNames cannot be empty');
    }
    for (let i = 0; i < storeNames.length; i++) {
      if (!validIdentifier(storeNames[i])) {
        throw new TypeError('IDBDatabase.transaction(): storeNames must only include valid identifiers');
      }
    }
    if (!('length' in storeNames) || !storeNames.length) {
      throw new TypeError('IDBDatabase.transaction(): storeNames must be an identifier or non-empty array of identifiers');
    }
    if (mode !== 'readonly' && mode !== 'readwrite') {
      throw new TypeError('IDBDatabase.transaction(): mode must be readwrite or readonly');
    }

    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase.transaction(): Database connection is closed', 'InvalidStateError');
    }
    if (this._closing) {
      throw new DOMException('IDBDatabase.transaction(): Database connection is closing', 'InvalidStateError');
    }

    // In 20ms run the database, to run this pending transaction.
    if (!this._timeout) setTimeout(() => this._run(), 20);

    // Return new transaction.
    const transaction = new IDBTransaction(this, storeNames, mode);
    this._queue.push(transaction);
    return transaction;
  }

  // Create object store.
  createObjectStore(storeName, {keyPath = null, autoIncrement = false} = {keyPath: null, autoIncrement: false}) {
    // Check params.
    if (!validIdentifier(storeName)) {
      throw new TypeError('IDBDatabase.createObjectStore(): storeName must be valid identifier');
    }
    if (!validKeyPath(keyPath) && keyPath !== null) {
      throw new TypeError('IDBDatabase.createObjectStore(): keyPath must be a valid keyPath or null');
    }
    if (typeof autoIncrement !== 'boolean') {
      throw new TypeError('IDBDatabase.createObjectStore(): autoIncrement must be boolean');
    }

    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase.transaction(): Database connection is closed', 'InvalidStateError');
    }
    if (!this._active) {
      throw new DOMException('IDBDatabase.createObjectStore(): Can only be used used when a transaction is running', 'InvalidStateError');
    }
    if (this._active.mode !== 'versionchange') {
      throw new DOMException('IDBDatabase.createObjectStore(): Can only be used used within an active \'versionchange\' transaction, not \'' + this._active.mode + '\'', 'InvalidStateError');
    }
    if (this._active._data[storeName]) {
      throw new DOMException('IDBDatabase.createObjectStore(): Object store \'' + storeName + '\' already exists', 'ConstraintError');
    }

    // Create a plain data template for this object store.
    this._active._data[storeName] = {records: new Map, indexes: {}, key: 0, keyPath, autoIncrement};

    // Make and return the new IDBObjectStore.
    return new IDBObjectStore(this._active, storeName);
  }

  // Delete object store.
  deleteObjectStore(storeName) {
    // Check params.
    if (!validIdentifier(storeName)) {
      throw new TypeError('IDBDatabase.deleteObjectStore(): storeName must be valid identifier');
    }

    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase.deleteObjectStore(): Database connection is closed', 'InvalidStateError');
    }
    if (!this._active) {
      throw new DOMException('IDBDatabase.deleteObjectStore(): Can only be used used within an active \'versionchange\' transaction', 'InvalidStateError');
    }
    if (this._active.mode !== 'versionchange') {
      throw new DOMException('IDBDatabase.deleteObjectStore(): Can only be used used within an active \'versionchange\' transaction', 'InvalidStateError');
    }
    if (!this._active._data[storeName]) {
      throw new DOMException('IDBDatabase.deleteObjectStore(): Object store \'' + storeName + '\' does not exist', 'NotFoundError');
    }

    // Delete the object store on the transaction.
    delete this._active._data[storeName];
  }

  // Close the connection to this database.
  // This will block any more transactions from being opened.
  close() {
    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase.close(): Database connection is closed', 'InvalidStateError');
    }
    if (this._closing) return; // Already closing.

    // Close is pending.
    // Blocks any new transactions from being made.
    this._closing = true;

    // Run any remaining transactions before we close.
    this._run();

    // Closed.
    this._closed = true;

    // Remove this connection from connections list.
    connections[this.name] = connections[this.name].filter((connection) => connection !== this);

    // Event.
    this.dispatchEvent(new Event('close', {bubbles: true}));
  }

  // Create a 'versionchange' transaction on this database.
  _upgradeTransaction() {
    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase._upgradeTransaction(): Database connection is closed', 'InvalidStateError');
    }
    if (this._closing) {
      throw new DOMException('IDBDatabase._upgradeTransaction(): Database connection is closing', 'InvalidStateError');
    }
    if (this._queue.length) {
      throw new DOMException('IDBDatabase._upgradeTransaction(): Database connection already has transactions', 'InvalidStateError');
    }


    // TODO(philipwalton): is accessing the global store the best way to get
    // these names?
    const storeNames =
        (storage[this.name] && Object.keys(storage[this.name])) || [];

    // Return new transaction.
    const transaction = new IDBTransaction(this, storeNames, 'versionchange');
    this._queue.push(transaction);
    return transaction;
  }

  // Run any pending transactions.
  _run() {
    // Check state.
    if (this._closed) {
      throw new DOMException('IDBDatabase._run(): Database connection is closed', 'InvalidStateError');
    }

    // Stop run() running run again in future.
    clearTimeout(this._timeout);
    this._timeout = false;

    // Run each transaction.
    while (this._queue.length) {
      // Activate and run.
      this._active = this._queue.shift();
      this._active._run();
      this._active = null;
    }
  }
}

// IDBTransaction mock.
class IDBTransaction extends EventTarget {
  // Construct.

  constructor(db, storeNames, mode = 'readonly') {
    // Check params.
    if (!(db instanceof IDBDatabase)) {
      throw new TypeError('IDBTransaction: db must be an IDBDatabase');
    }
    if (!(storeNames instanceof Array)) {
      throw new TypeError('IDBTransaction: storeNames must be array');
    }
    for (let i = 0; i < storeNames.length; i++) {
      if (!validIdentifier(storeNames[i])) {
        throw new TypeError('IDBTransaction: storeNames must only include valid identifiers');
      }
    }
    if (mode !== 'readonly' && mode !== 'readwrite' && mode !== 'versionchange') {
      throw new TypeError('IDBTransaction: mode must be readwrite, readonly, or versionchange');
    }

    // EventTarget.
    super(db, ['complete', 'error', 'abort']);

    this._db = db;
    this._mode = mode;
    this._storeNames = storeNames;

    // Vars.
    this._stores = {}; // List of instantiated IDBObjectStore instances that have been initialised for this transaction.
    this._queue = []; // Secret requests queue for this transaction.
    this._finished = false; // Whether this transaction is finished or not (can have requests made on it).
    this._active = null; // The active request on this transaction.
    this._aborted = false; // Whether this transaction has been aborted.

    // TODO(philipwalton): in the original this was a getter that prevented
    // setting, but we have to allow setting in the `_run()` method.
    this._data = db._data;
  }

  get db() {
    return this._db;
  }

  get mode() {
    return this._mode;
  }

  get objectStoreNames() {
    const storeNames = this._storeNames.slice();
    // Fake contains from DOMStringList
    storeNames.contains = (value) => storeNames.includes(value);
    return storeNames;
  }

  get error() {
    if (!this._finished) {
      throw new Error('IDBTransaction: error can only be accessed after transaction has finished');
    }
    return null;
  }


  // Get object store.
  objectStore(storeName) {
    // Check params.
    if (!validIdentifier(storeName)) {
      throw new TypeError('IDBTransaction.objectStore(): storeName must be valid identifier');
    }
    // Check state.
    if (this._finished) {
      throw new DOMException('IDBTransaction.objectStore(): Transaction has already finished', 'InvalidStateError');
    }

    if (!this.objectStoreNames.contains(storeName)) {
      // TODO(philipwalton): fix versionchange transactions failing.
      throw new DOMException('IDBTransaction.objectStore(): Object store is not in this transaction\'s scope', 'NotFoundError');
    }

    if (!this._data[storeName]) {
      // TODO(philipwalton): fix versionchange transactions failing.
      throw new DOMException('IDBTransaction.objectStore(): Object store \'' + storeName + '\' does not exist', 'NotFoundError');
    }

    // Make a new IDBObjectStore instance.
    // Add it to the list of instantiated object stores and return it.
    if (!this._stores[storeName]) {
      this._stores[storeName] = new IDBObjectStore(this, storeName);
    }
    return this._stores[storeName];
  }

  // Abort this transaction.
  // Means that changes made by this transaction won't be committed.
  abort() {
    // Checks.
    if (this._finished) {
      throw new DOMException('IDBTransaction.abort(): Transaction has already finished', 'InvalidStateError');
    }

    // Aborted.
    this._finished = true;
    this._aborted = true;
  }

  // Add a request to this transaction.
  _request(input, callback) {
    // Checks.
    if (this._finished) {
      throw new DOMException('IDBTransaction: Cannot create request when transaction has already finished', 'InvalidStateError');
    }

    // New or existing request.
    if (input instanceof IDBRequest) {
      // Existing request.
      this._queue.push(input);
      return input;
    } else {
      // Create request, add to queue, and return it.
      const request = new IDBRequest(input, callback);
      this._queue.push(request);
      return request;
    }
  }

  // Run this transaction.
  _run() {
    // Check state.
    if (this._finished) {
      throw new DOMException('IDBTransaction._run(): Transaction has already finished', 'InvalidStateError');
    }
    if (this._active) {
      throw new DOMException('IDBTransaction._run(): Transaction is currently running', 'InvalidStateError');
    }

    const originalDataRef = this._data;
    this._data = {};
    for (const store in originalDataRef) {
      // This is fussy because we need to clone the records Map manually.
      // clone() borks at any non-JSON values.
      this._data[store] = Object.assign({}, originalDataRef[store], {
        records: new Map(originalDataRef[store].records),
        indexes: Object.assign({}, originalDataRef[store].indexes),
      });
    }

    // Run each request in the request queue.
    while (!this._aborted && this._queue.length) {
      // Activate and run.
      this._active = this._queue.shift();
      this._active._run();
      this._active = false;
    }

    // Was it aborted?
    if (this._aborted) {
      // Abort any pending queue.
      while (this._queue.length) this._queue.shift()._abort();

      // Finished.
      this._finished = true;

      // 'abort' event.
      // This is a 'non-erroring' abort, i.e. 'error' isn't set.
      this.dispatchEvent(new Event('abort', {bubbles: true, cancelable: false}));
    } else {
      // Commit the changes back into the database.
      for (const store in originalDataRef) {
        delete originalDataRef[store];
      }
      for (const store in this._data) {
        originalDataRef[store] = this._data[store];
      }

      // Finished.
      this._finished = true;

      // 'complete' event.
      this.dispatchEvent(new Event('complete', {bubbles: false, cancelable: false}));
    }
  }
}

// IDBRequest mock.
class IDBRequest extends EventTarget {
  // Construct.
  constructor(input, callback) {
    // Check params.
    let transaction;
    let source;

    if (input instanceof IDBTransaction) {
      transaction = input;
      source = null;
    } else if (input instanceof IDBObjectStore) {
      transaction = input.transaction;
      source = input;
    } else if (input instanceof IDBIndex) {
      transaction = input.objectStore.transaction;
      source = input;
    } else {
      throw new TypeError('IDBRequest: input must be an IDBTransaction, IDBObjectStore, or IDBIndex');
    }
    if (!(transaction instanceof IDBTransaction)) {
      throw new TypeError('IDBRequest: transaction must be an IDBTransaction');
    }
    if (typeof callback !== 'function') {
      throw new TypeError('IDBRequest: callback must be a function');
    }

    // EventTarget.
    super(transaction, ['success', 'error']);

    this._callback = callback;
    this._transaction = transaction;
    this._source = source;

    // Vars.
    this._result = undefined; // The result, if any, that this request generated.
    this._active = true; // Whether request is still active (pending) or complete (done).
    this._error = undefined; // Error, if any, on this request. Used when request is aborted.
  }

  get callback() {
    return this._callback;
  }

  get transaction() {
    return this._transaction;
  }

  get source() {
    return this._source;
  }

  get readyState() {
    return this._active ? 'pending' : 'done';
  }

  get result() {
    if (this._active) {
      throw new DOMException('IDBRequest: Cannot get result until request is done', 'InvalidStateError');
    }
    return this._result;
  }

  get error() {
    if (this._active) {
      throw new DOMException('IDBRequest: Cannot get error until request is done', 'InvalidStateError');
    }
    return this._error;
  }

  // Run this request.
  _run() {
    // Get result.
    this._active = true;
    this._result = this.callback(this);
    this._active = false;

    // Event.
    this.dispatchEvent(new Event('success', {bubbles: false, cancelable: false}));
  }

  // Rerun this request.
  // By adding it to the end of its transaction's queue.
  _rerun() {
    // Add to the request queue for the transaction.
    // Will fail if the transaction has already finished.
    this._transaction._request(this);
  }

  // Abort this request.
  // Called when this request is part of an aborted transaction.
  _abort() {
    // Error.
    this._result = undefined;
    this._error = new DOMException('IDBRequest: Request\'s transaction has been aborted', 'AbortError');
    this._active = false;

    // Event.
    this.dispatchEvent(new Event('error', {bubbles: true, cancelable: true}));
  }
}

// IDBOpenDBRequest mock.
class IDBOpenDBRequest extends EventTarget {
  // Construct.
  constructor(dbName, version) {
    // Checks.
    if (!validIdentifier(dbName)) {
      throw new TypeError('IDBOpenDBRequest: dbName must be valid identifier');
    }
    if (!validVersion(version) && version !== false) {
      throw new TypeError('IDBOpenDBRequest: version must be a valid version or false');
    }

    // EventTarget.
    super(null, ['success', 'error', 'blocked', 'upgradeneeded']);

    this._dbName = dbName;
    this._version = version;

    // Vars.
    this._result = undefined; // The result, if any, that this request generated.
    this._active = true; // Whether request is still active (pending) or complete (done).
    this._transaction = null; // Transaction under this request.

    // Open requests automatically run.
    // Allow 20ms — enough time for user to attach handlers etc.
    setTimeout(() => this.run(), 20);
  }

  get transaction() {
    return this._transaction;
  }

  get source() {
    return null;
  }

  get readyState() {
    return this._active ? 'pending' : 'done';
  }

  get result() {
    if (this._active) {
      throw new DOMException('IDBRequest: Cannot get result until request is done', 'InvalidStateError');
    }
    return this._result;
  }

  get error() {
    if (this._active) {
      throw new DOMException('IDBRequest: Cannot get error until request is done', 'InvalidStateError');
    }
    return null;
  }

  // Run this request.
  run() {
    // Vars.
    const oldVersion = versions[this._dbName] || 0;

    // Check state.
    if (!this._active) {
      throw new DOMException('IDBOpenDBRequest._run(): Request has already been run', 'InvalidStateError');
    }

    // Already stopped.
    this._active = false;

    // Check version.
    if (!this._version) {
      // Delete request (falsy/zero version).
      if (!this.close()) return;

      // Delete.
      delete connections[this._dbName];
      delete versions[this._dbName];
      delete storage[this._dbName];

      // Success.
      this.dispatchEvent(new Event('success', {bubbles: false, cancelable: false}));
    } else if (this._version < oldVersion) {
      // Request for an older version.
      throw new DOMException('IDBOpenDBRequest: Requested version is lower than current version', 'VersionError');
    } else if (this._version === oldVersion) {
      // Request for current version.
      this._result = new IDBDatabase(this._dbName, this._version, storage[this._dbName]);

      // Dispatch 'success'.
      this.dispatchEvent(new Event('success', {bubbles: false, cancelable: false}));
    } else if (this._version > oldVersion) {
      // Request for a newer version.
      // Close all connections first.
      if (!this.close()) return;

      // Make a database.
      // TODO(philipwalton): the new version of the data should get the data
      // from the existing version (if one exists).
      // const db = new IDBDatabase(this._dbName, this._version, {}); // New database.
      const db = new IDBDatabase(this._dbName, this._version, storage[this._dbName] || {});

      const tx = db._upgradeTransaction(); // 'versionchange' transaction.

      // Add a temp/wrapper request on the transaction.
      tx._request(tx, () => {
        // Result is DB.
        this._result = db;

        // Dispatch 'upgradeneeded' on the IDBOpenDBRequest.
        this._transaction = tx;
        this.dispatchEvent(new IDBVersionChangeEvent('upgradeneeded', oldVersion, this._version));
        this._transaction = null;
      });

      // Run the database now to run the 'versionchange' transaction.
      db._run();

      // Commit the changes.
      versions[this._dbName] = this._version; // Increment version number.
      storage[this._dbName] = db._data; // Set current global data store to request database's store.

      // Dispatch 'success' event on the open request.
      this.dispatchEvent(new Event('success', {bubbles: false, cancelable: false}));
    }
  }

  // Close all other connections.
  close() {
    // Are there connections open?
    if (connections[this._dbName] && connections[this._dbName].length) {
      // Close other connections (dispatch 'versionchange' on each).
      // If connections are still open, block this open request.
      connections[this._dbName].forEach((connection) => connection.dispatchEvent(new Event('versionchange', {bubbles: false, cancelable: false})));

      // Fail if connections are still open.
      if (connections[this._dbName].length) {
        // 'blocked' event.
        this.dispatchEvent(new Event('blocked', {bubbles: false, cancelable: false}));

        // Fail.
        return false;
      }
    }

    // Win.
    return true;
  }
}

// IDBObjectStore mock.
class IDBObjectStore {
  // Construct.
  constructor(transaction, name) {
    // Check params.
    if (!(transaction instanceof IDBTransaction)) {
      throw new TypeError('IDBObjectStore: transaction must be a transaction');
    }
    if (!validIdentifier(name)) {
      throw new TypeError('IDBObjectStore: storeName must be valid identifier');
    }

    // Check state.
    if (transaction._finished) {
      throw new DOMException('IDBObjectStore: Transaction has finished', 'InvalidStateError');
    }
    if (!transaction._data[name]) {
      throw new DOMException('IDBObjectStore: Object store \'' + name + '\' does not exist', 'InvalidStateError');
    }

    this._transaction = transaction;
    this._name = name;
    this._keyPath = this._transaction._data[this._name].keyPath;
    this._autoIncrement = this._transaction._data[this._name].autoIncrement;
  }

  get transaction() {
    return this._transaction;
  }

  get name() {
    return this._name;
  }

  get keyPath() {
    return this._keyPath;
  }

  get autoIncrement() {
    return this._autoIncrement;
  }

  get indexNames() {
    const names = Object.keys(this._transaction._data[this._name].indexes); names.sort();
    return names;
  }

  // Count documents.
  count(key = undefined) {
    // Check params.
    if (!validKey(key) && !validKeyRange(key) && key !== undefined) {
      throw new DOMException('count(): The key parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or undefined', 'DataError');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.count(): Transaction has finished', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction returns the count from a cursor.
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.count(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBIndex.count(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Return the number of keys found on the cursor.
      return new IDBCursor(request, key)._count;
    });
  }

  // Get a single result.
  // Returns a request that fires a 'success' event when its result is available.
  // `request.result` will be either:
  // 1. The value for the first result with a key matching `key`.
  // 2. `undefined`, if there are no matching results.
  get(key = undefined) {
    // Check params.
    if (!validKey(key) && !validKeyRange(key) && key !== undefined) {
      throw new DOMException('count(): The key parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or undefined', 'DataError');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.get(): Transaction has finished', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction.
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.get(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBIndex.get(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Return the value of the first key found by the cursor.
      return new IDBCursorWithValue(request, key).value;
    });
  }

  // Open a cursor to retrieve several results.
  // Returns a request that fires one or more 'success' events when its results is available.
  // Continues to fire 'success' as many times as `cursor.continue()` is called and results are available.
  // request.result will be either:
  // 1. An `IDBCursor` (with `cursor.value` and `cursor.key` to read values, and `cursor.continue()` method to continue).
  // 2. `undefined`, if there are no more results.
  openCursor(query = undefined, direction = 'next') {
    if (query === null) {
      // Edge / IE allow for 'null' to be passed, but it is treated as 'undefined' for mock purposes.
      query = undefined;
    }
    // Check params.
    if (!validKey(query) && !validKeyRange(query) && query !== undefined) {
      throw new DOMException('count(): The query parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or, it is not null or undefined', 'DataError');
    }
    if (direction !== 'next' && direction !== 'prev') {
      throw new TypeError('IDBCursor: direction must be one of \'next\' or \'prev\' (\'nextunique\' or \'prevunique\' are not relevant for primary keys, which must be unique)');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.openCursor(): Transaction has finished', 'InvalidStateError');
    }

    // Return an IDBRequest.
    // The result of the request is an IDBCursor (if there's a value at the current cursor position),
    // or undefined (if there isn't, because we iterated past the end or there were no results).
    let cursor;
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.openCursor(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBIndex.openCursor(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Make a cursor if it doesn't exist.
      // Don't create the cursor until the request is run.
      // (Otherwise records added by other requests between this request being created and it being run, won't be included.)
      if (!cursor) cursor = new IDBCursorWithValue(request, query, direction);

      // Return cursor if there is a value.
      return cursor.primaryKey !== undefined ? cursor : undefined;
    });
  }

  // Save a document to a specified key.
  // Returns a request that fires 'success' event when `value` has been saved under `key`.
  put(value, key, {_errorOnExistingKey = false} = {}) {
    // Check params.
    if (this._keyPath) {
      // Value must be an object if keyPath is set.
      if (!(value instanceof Object)) {
        throw new DOMException('IDBObjectStore.put(): value must be an object for object stores where a keyPath is set', 'DataError');
      }

      // Checks for in-line keys (key at value.keyPath).
      // key parameter must not be set.
      if (key !== undefined) {
        throw new DOMException('IDBObjectStore.put(): key parameter cannot be set (use value.' + this._keyPath + ' instead)', 'DataError');
      }
      key = value[this._keyPath];
      if (key !== undefined && !validKey(key)) {
        throw new DOMException('IDBObjectStore.put(): inline key (value.' + this._keyPath + ') must be a valid key (number, string, date)', 'DataError');
      }
      if (key === undefined && !this._autoIncrement) {
        throw new DOMException('IDBObjectStore.put(): inline key (value.' + this._keyPath + ') must be set (object store does not autoincrement)', 'DataError');
      }
    } else {
      // Checks for out-of-line keys (key parameter).
      if (key !== undefined && !validKey(key)) {
        throw new DOMException('IDBObjectStore.put(): key parameter must be valid key (number, string, date)', 'DataError');
      }
      if (key === undefined && !this._autoIncrement) {
        throw new DOMException('IDBObjectStore.put(): key parameter must be set (object store does not autoincrement)', 'DataError');
      }
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.put(): Transaction has finished', 'InvalidStateError');
    }
    if (this._transaction.mode === 'readonly') {
      throw new DOMException('IDBObjectStore.put(): Transaction is read only', 'ReadOnlyError');
    }

    // Clone.
    try {
      value = clone(value);
    } catch (err) {
      throw new DOMException('IDBObjectStore.put(): value must be JSON-friendly value (string, finite number, null, true, false, plain array, plain object)', 'DataCloneError');
    }

    // Return an IDBRequest on the transaction that saves the value at the key.
    return this._transaction._request(this, () => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.put(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBObjectStore.put(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      const records = this._transaction._data[this._name].records;

      if (_errorOnExistingKey && records.has(key)) {
        throw new DOMException('IDBObjectStore.add(): Key already exists in the object store.', 'ConstraintError');
      }

      // Generate a key if it's not set.
      if (key === undefined) {
        // Generate a key.
        this._transaction._data[this._name].key++;
        key = this._transaction._data[this._name].key;

        // Set key on value if keyPath is set.
        if (this._keyPath) value[this._keyPath] = key;
      }

      // Save the value.
      records.set(key, value);

      return key;
    });
  }

  add(value, key) {
    return this.put(value, key, {_errorOnExistingKey: true});
  }

  // Delete a record by key.
  delete(range) {
    // Check params.
    if (!validKey(range) && !validKeyRange(range)) {
      throw new DOMException('IDBObjectStore.delete(): The range parameter was provided but does not contain a valid key (number, string, date) or key range (IDBKeyRange or array of valid keys)', 'DataError');
    }

    // Check state.
    if (this._transaction.mode === 'readonly') {
      throw new DOMException('IDBObjectStore.delete(): Transaction is read only', 'ReadOnlyError');
    }
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.delete(): Transaction has finished', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction that deletes values in the range.
    return this._transaction._request(this, () => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.delete(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBObjectStore.delete(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Delete matching keys in records.
      const records = this._transaction._data[this._name].records;
      for (const [primary] of records) {
        if (keyInRange(primary, range)) {
          records.delete(primary);
        }
      }
    });
  }

  // Clear all documents.
  clear() {
    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.clear(): Transaction has finished', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction that deletes everything in the store.
    return this._transaction._request(this, () => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBObjectStore.clear(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._name]) {
        throw new DOMException('IDBObjectStore.clear(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Clear all records.
      this._transaction._data[this._name].records.clear();
    });
  }

  // Get an existing index.
  index(indexName) {
    // Check params.
    if (!validIdentifier(indexName)) {
      throw new TypeError('IDBObjectStore.index(): indexName must be a valid identifier');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.index(): Transaction has finished', 'InvalidStateError');
    }
    if (!this._transaction._data[this._name]) {
      throw new DOMException('IDBObjectStore.index(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._name].indexes[indexName]) {
      throw new DOMException('IDBObjectStore.index(): Index \'' + indexName + '\' does not exist', 'InvalidStateError');
    }

    // Return the existing index.
    return new IDBIndex(this, indexName);
  }

  // Create an index on this object store.
  createIndex(indexName, keyPath, {unique = false, multiEntry = false} = {unique: false, multiEntry: false}) {
    // Check params.
    if (!validIdentifier(indexName)) {
      throw new TypeError('IDBObjectStore.createIndex(): indexName must be a valid identifier');
    }
    if (!validKeyPath(keyPath) && !validMultiKeyPath(keyPath)) {
      throw new TypeError('IDBObjectStore.createIndex(): keyPath must be a valid key path (\'a\' or \'a.b\') or array of valid key paths');
    }
    if (typeof unique !== 'boolean') {
      throw new TypeError('IDBObjectStore.createIndex(): unique must be boolean');
    }
    if (typeof multiEntry !== 'boolean') {
      throw new TypeError('IDBObjectStore.createIndex(): multiEntry must be boolean');
    }

    // Block array keys.
    if (validMultiKeyPath(keyPath)) {
      throw new TypeError('IDBObjectStore.createIndex(): array keyPaths are not yet supported by this mock'); // @todo add support for array keyPaths.
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.createIndex(): Transaction has finished', 'InvalidStateError');
    }
    if (this._transaction.mode !== 'versionchange') {
      throw new DOMException('IDBObjectStore.createIndex(): Can only be used used within an active \'versionchange\' transaction, not \'' + this._transaction.mode + '\'', 'InvalidStateError');
    }
    if (!this._transaction._data[this._name]) {
      throw new DOMException('IDBObjectStore.createIndex(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
    }
    if (this._transaction._data[this._name].indexes[indexName]) {
      throw new DOMException('IDBObjectStore.createIndex(): Index already exists', 'ConstraintError');
    }

    // Create a plain data template for this index.
    this._transaction._data[this._name].indexes[indexName] = {keyPath: keyPath, unique: unique, multiEntry: multiEntry};

    // Return a new IDBIndex.
    return new IDBIndex(this, indexName);
  }

  // Delete an index on this object store.
  deleteIndex(indexName) {
    // Check params.
    if (!validIdentifier(indexName)) {
      throw new TypeError('IDBObjectStore.deleteIndex(): indexName must be a valid identifier');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBObjectStore.deleteIndex(): Transaction has finished', 'InvalidStateError');
    }
    if (this._transaction.mode !== 'versionchange') {
      throw new DOMException('IDBObjectStore.deleteIndex(): Can only be used used within an active \'versionchange\' transaction, not \'' + this._transaction.mode + '\'', 'InvalidStateError');
    }
    if (!this._transaction._data[this._name]) {
      throw new DOMException('IDBObjectStore.deleteIndex(): Object store \'' + this._name + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._name].indexes[indexName]) {
      throw new DOMException('IDBObjectStore.deleteIndex(): Index \'' + indexName + '\' does not exist', 'NotFoundError');
    }

    // Delete the index.
    delete this._transaction._data[this._name].indexes[indexName];
  }
}

// IDBIndex mock.
class IDBIndex {
  // Construct.
  constructor(objectStore, name) {
    // Check params.
    if (!(objectStore instanceof IDBObjectStore)) {
      throw new TypeError('IDBIndex: store must be an IDBObjectStore');
    }
    if (!validIdentifier(name)) {
      throw new TypeError('IDBIndex: name must be a valid identifier');
    }

    // Vars.
    this._objectStore = objectStore;
    this._name = name;
    this._storeName = objectStore.name;
    this._transaction = objectStore.transaction;

    // Check state.
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('IDBIndex: Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName].indexes[this._name]) {
      throw new DOMException('IDBIndex: Index \'' + this._name + '\' does not exist', 'InvalidStateError');
    }

    // Vars.
    this._keyPath = this._transaction._data[this._storeName].indexes[this._name].keyPath;
    this._unique = this._transaction._data[this._storeName].indexes[this._name].unique;
    this._multiEntry = this._transaction._data[this._storeName].indexes[this._name].multiEntry;
  }

  get objectStore() {
    return this._objectStore;
  }

  get name() {
    return this._name;
  }

  get keyPath() {
    return this._keyPath;
  }

  get multiEntry() {
    return this._multiEntry;
  }

  get unique() {
    return this._unique;
  }

  // Count documents.
  count(key = undefined) {
    // Check params.
    if (!validKey(key) && !validKeyRange(key) && key !== undefined) {
      throw new DOMException('count(): The key parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or undefined', 'DataError');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBIndex.count(): Transaction has finished', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('IDBIndex.count(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName].indexes[this._name]) {
      throw new DOMException('IDBIndex.count(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction returns the count from a cursor.
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBIndex.count(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName]) {
        throw new DOMException('IDBIndex.count(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName].indexes[this._name]) {
        throw new DOMException('IDBIndex.count(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Return the number of keys found on the cursor.
      return new IDBCursor(request, key)._count;
    });
  }

  // Get a single result.
  // Returns a request that fires a 'success' event when its result is available.
  // `request.result` will be either:
  // 1. The value for the first result with a key matching `key`.
  // 2. `undefined`, if there are no matching results.
  get(key = undefined) {
    // Check params.
    if (!validKey(key) && !validKeyRange(key) && key !== undefined) {
      throw new DOMException('count(): The key parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or undefined', 'DataError');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBIndex.get(): Transaction has finished', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('IDBIndex.get(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName].indexes[this._name]) {
      throw new DOMException('IDBIndex.get(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
    }

    // Return an IDBRequest on the transaction.
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBIndex.get(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName]) {
        throw new DOMException('IDBIndex.get(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName].indexes[this._name]) {
        throw new DOMException('IDBIndex.get(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Return the value of the first key found by the cursor.
      return new IDBCursorWithValue(request, key).value;
    });
  }

  // Open a cursor to retrieve several results.
  // Returns a request that fires one or more 'success' events when its results is available.
  // Continues to fire 'success' as many times as `cursor.continue()` is called and results are available.
  // request.result will be either:
  // 1. An `IDBCursor` (with `cursor.value` and `cursor.key` to read values, and `cursor.continue()` method to continue).
  // 2. `undefined`, if there are no more results.
  openCursor(query = undefined, direction = 'next') {
    if (query === null) {
      // Edge / IE allow for 'null' to be passed, but it is treated as 'undefined' for mock purposes.
      query = undefined;
    }
    // Check params.
    if (!validKey(query) && !validKeyRange(query) && query !== undefined) {
      throw new DOMException('count(): The query parameter was provided but does not contain a valid key (number, string, date), key range (IDBKeyRange or array of valid keys), or, it is not null or undefined', 'DataError');
    }
    if (direction !== 'next' && direction !== 'nextunique' && direction !== 'prev' && direction !== 'prevunique') {
      throw new TypeError('IDBCursor: direction must be one of \'next\', \'nextunique\', \'prev\', \'prevunique\'');
    }

    // Check state.
    if (this._transaction._finished) {
      throw new DOMException('IDBIndex.openCursor(): Transaction has finished', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('IDBIndex.openCursor(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName].indexes[this._name]) {
      throw new DOMException('IDBIndex.openCursor(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
    }

    // Return an IDBRequest.
    // The result of the request is an IDBCursor (if there's a value at the current cursor position),
    // or undefined (if there isn't, because we iterated past the end or there were no results).
    let cursor;
    return this._transaction._request(this, (request) => {
      // Check state.
      if (this._transaction._finished) {
        throw new DOMException('IDBIndex.openCursor(): Transaction has finished', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName]) {
        throw new DOMException('IDBIndex.openCursor(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
      }
      if (!this._transaction._data[this._storeName].indexes[this._name]) {
        throw new DOMException('IDBIndex.openCursor(): Index \'' + this._name + '\' does not exist', 'InvalidStateError');
      }

      // Make a cursor if it doesn't exist.
      // Don't create the cursor until the request is run.
      // (Otherwise records added by other requests between this request being created and it being run, won't be included.)
      if (!cursor) cursor = new IDBCursorWithValue(request, query, direction);

      // Return cursor if there is a value.
      return cursor.primaryKey !== undefined ? cursor : undefined;
    });
  }
}

// IDBCursor mock.
class IDBCursor {
  // Construct.
  constructor(request, range = undefined, direction = 'next', withValue = false) {
    // Check params.
    if (!(request instanceof IDBRequest)) {
      throw new TypeError('IDBCursor: request must be an IDBRequest');
    }
    if (!(request.source instanceof IDBObjectStore) && !(request.source instanceof IDBIndex)) {
      throw new TypeError('IDBCursor: request must have a source that must be an IDBObjectStore or an IDBIndex');
    }
    if (direction !== 'next' && direction !== 'nextunique' && direction !== 'prev' && direction !== 'prevunique') {
      throw new TypeError('IDBCursor: direction must be one of \'next\', \'nextunique\', \'prev\', \'prevunique\'');
    }
    if (!validKey(range) && !validKeyRange(range) && range !== undefined) {
      throw new TypeError('IDBCursor: range must be a valid key (string, number, date), key range (array, IDBKeyRange), or undefined');
    }

    this._request = request;
    this._range = range;
    this._direction = direction;
    this._withValue = withValue;

    // Vars.
    this._transaction = this._request.transaction;
    this._source = this._request.source;
    this._store = this._source instanceof IDBObjectStore ? this._source : this._source.objectStore;
    this._storeName = this._store.name;
    this._index = this._source instanceof IDBIndex ? this._source : null;
    this._indexName = this._index ? this._index.name : null;

    // Check state.
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('IDBCursor: Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }
    if (this._index && !this._transaction._data[this._storeName].indexes[this._indexName]) {
      throw new DOMException('IDBCursor: Index \'' + this._indexName + '\' does not exist', 'InvalidStateError');
    }

    // Vars.
    this._keys = this._find(this._transaction._data[this._storeName].records);
    this._count = this._keys.length;
    this._value = undefined;
    this._key = undefined;
    this._primaryKey = undefined;

    // Go to the first key.
    this.progress();
  }

  get request() {
    return this._request;
  }

  get source() {
    return this._source;
  }

  get direction() {
    return this._direction;
  }

  get key() {
    return this._key;
  }

  get primaryKey() {
    return this._primaryKey;
  }

  get value() {
    if (this._withValue) {
      return this._value;
    } else {
      return undefined;
    }
  }

  // Functions.
  progress() {
    // Set key, value, primaryKey
    if (this._keys.length) {
      // Get key and primaryKey from list.
      this._key = this._keys[0][0];
      this._primaryKey = this._keys[0][1];
      this._keys.shift();

      // Fill in the value if neccessary.possible.
      if (this._withValue) {
        this._value = this._transaction._data[this._storeName].records.get(this._primaryKey);
      }
    } else {
      this._key = undefined;
      this._primaryKey = undefined;
      this._value = undefined;
    }
  }

  // Sets the number times a cursor should move its position forward.
  advance(count) {
    // Check params.
    if (typeof count !== 'number') {
      throw new TypeError('advance(): count must be a number');
    }
    if (count <= 0) {
      throw new TypeError('advance(): count must be 1 or more');
    }

    // Check state.
    if (!this._keys.length) {
      throw new DOMException('advance(): Cursor has iterated past the end of the set', 'InvalidStateError');
    }
    if (this._request.readyState !== 'done') {
      throw new DOMException('advance(): Cursor is currently iterating', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('advance(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }

    // Move forward by count.
    for (let i = 0; i < count; i++) {
      this.this.progress();
    }

    // Run the request again.
    this._request._rerun();
  }

  // Continue on to the next one, or onto a specific one.
  continue(targetKey = undefined) {
    // Check params.
    if (!validKey(targetKey) && !validKeyRange(targetKey) && targetKey !== undefined) {
      throw new DOMException('continue(): targetKey must be a valid key (string, number, date), key range (array or IDBKeyRange), or undefined', 'DataError');
    }

    // Check state.
    if (this._primaryKey == null) { // Check for null/undefined because 0 is a valid key.
      throw new DOMException('continue(): Cursor has iterated past the end of the set', 'InvalidStateError');
    }
    if (this._request.readyState !== 'done') {
      throw new DOMException('continue(): Cursor is currently iterating', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('continue(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }

    // Move forward by one.
    this.progress();

    // If key is not null, continue to progress until we find key or reach the end.
    if (targetKey !== undefined) while (this._primaryKey !== undefined && !keyInRange(this._key, targetKey)) {
      this.progress();
    }

    // Run the request again.
    this._request._rerun();
  }

  // Continue on to the next one that matches
  continuePrimaryKey(targetKey, targetPrimaryKey) {
    // Check params.
    if (!validKey(targetKey) && !validKeyRange(targetKey)) {
      throw new DOMException('continuePrimaryKey(): targetKey must be a valid key (string, number, date) or key range (array or IDBKeyRange)', 'DataError');
    }
    if (!validKey(targetPrimaryKey) && !validKeyRange(targetPrimaryKey)) {
      throw new DOMException('continuePrimaryKey(): targetPrimaryKey must be a valid key (string, number, date) or key range (array or IDBKeyRange)', 'DataError');
    }

    // Check state.
    if (!this._keys.length) {
      throw new DOMException('continuePrimaryKey(): Cursor has iterated past the end of the set', 'InvalidStateError');
    }
    if (this._request.readyState !== 'done') {
      throw new DOMException('continuePrimaryKey(): Cursor is currently iterating', 'InvalidStateError');
    }
    if (!this._transaction._data[this._storeName]) {
      throw new DOMException('continuePrimaryKey(): Object store \'' + this._storeName + '\' does not exist', 'InvalidStateError');
    }

    // Continue until we find a value that has the right key and primaryKey.
    while (this._primaryKey !== undefined &&
        !keyInRange(this._key, targetKey) &&
        !keyInRange(this._primaryKey, targetPrimaryKey)) {
      this.progress();
    }

    // Run the request again.
    this._request._rerun();
  }

  // Delete the current primary key.
  delete() {
    if (this._withValue) {
      // Checks.
      if (this._primaryKey !== null) {
        throw new DOMException('delete(): Cursor does not have a value', 'InvalidStateError');
      }

      // Return a request from IDBObjectStore.delete().
      return this._store.delete(this._primaryKey);
    }
  }

  // Update the current primary key.
  update(value) {
    if (this._withValue) {
      // Checks.
      if (this._primaryKey !== null) {
        throw new DOMException('update(): Cursor does not have a value', 'InvalidStateError');
      }

      // Return a request from IDBObjectStore.put().
      return this._store.put(value, this._primaryKey);
    }
  }

  // Find matching keys.
  _find(records) {
    // Vars.
    const keys = [];

    // Source is index or object store?
    if (this._index) {
      // Index source.
      // Loop through records.
      for (const [primary, value] of records) {
        // Get key at index.keyPath and filter.
        const key = (value instanceof Object ? value[this._index.keyPath] : undefined);
        if (this._range === undefined || keyInRange(key, this._range)) keys.push([key, primary]);
      }
    } else {
      // Object store source.
      // Loop through records and filter.
      for (const [primary] of records) {
        if (this._range === undefined || keyInRange(primary, this._range)) {
          keys.push([primary, primary]);
        }
      }
    }

    // Sort the keys by key.
    const sortedKeys = keys.sort((a, b) => IDBFactory.cmp(a[0], b[0]));

    // Possibly remove duplicate keys.
    if (this._direction === 'nextunique' || this._direction === 'prevunique') {
      for (let i = sortedKeys.length-2; i >= 0; i--) {
        if (sortedKeys[i] === sortedKeys[i+1]) {
          sortedKeys.splice(i+1, 1);
        }
      }
    }

    // Possibly reverse the keys.
    if (this._direction === 'prev' || this._direction === 'prevunique') sortedKeys.reverse();

    // Return.
    return sortedKeys;
  }
}

// IDBCursorWithValue mock.
class IDBCursorWithValue extends IDBCursor {
  // Construct.
  constructor(request, range = undefined, direction = 'next') {
    // Super.
    super(request, range, direction, true);
  }
}

// IDBKeyRange mock.
class IDBKeyRange {
  // Construct.
  constructor(lower, upper, lowerOpen = false, upperOpen = false) {
    // Checks.
    if (!validKey(lower) && lower !== undefined) {
      throw new DOMException('IDBKeyRange: lower must be a valid key (string, number, date) or undefined', 'DataError');
    }
    if (!validKey(upper) && upper !== undefined) {
      throw new DOMException('IDBKeyRange: upper must be a valid key (string, number, date) or undefined', 'DataError');
    }
    if (typeof lowerOpen !== 'boolean') {
      throw new DOMException('IDBKeyRange: lowerOpen must be boolean', 'DataError');
    }
    if (typeof upperOpen !== 'boolean') {
      throw new DOMException('IDBKeyRange: upperOpen must be boolean', 'DataError');
    }
    if (lower > upper) {
      throw new DOMException('IDBKeyRange: lower must be lower than upper', 'DataError');
    }

    this._lower = lower;
    this._upper = upper;
    this._lowerOpen = lowerOpen;
    this._upperOpen = upperOpen;
  }

  // Properties.
  get lower() {
    return this._lower;
  }

  get upper() {
    return this._upper;
  }

  get lowerOpen() {
    return this._lowerOpen;
  }

  get upperOpen() {
    return this._upperOpen;
  }

  // Whether or not the given value is included in this range.
  includes(key) {
    // Checks.
    if (!validKey(key)) {
      throw new DOMException('includes(): key must be a valid key (string, number, date)', 'DataError');
    }

    // See if it's in the range.
    if (this._upper !== undefined) {
      if (this._upperOpen) {
        if (key >= this._upper) return false;
      } else {
        if (key > this._upper) return false;
      }
    }
    if (this._lower !== undefined) {
      if (this._lowerOpen) {
        if (key <= this._lower) return false;
      } else {
        if (key < this._lower) return false;
      }
    }
    return true;
  }
}

// Create a key range with upper/lower bounds (static).
IDBKeyRange.bound = function(lower, upper, lowerOpen = false, upperOpen = false) {
  // Checks.
  if (!validKey(lower)) {
    throw new DOMException('bound(): lower must be a valid key (string, number, date)', 'DataError');
  }
  if (!validKey(upper)) {
    throw new DOMException('bound(): upper must be a valid key (string, number, date)', 'DataError');
  }
  if (typeof lowerOpen !== 'boolean') {
    throw new DOMException('bound(): lowerOpen must be boolean', 'DataError');
  }
  if (typeof upperOpen !== 'boolean') {
    throw new DOMException('bound(): upperOpen must be boolean', 'DataError');
  }
  if (lower > upper) {
    throw new DOMException('bound(): lower must be lower than upper', 'DataError');
  }

  // Make an IDBKeyRange and return it.
  return new IDBKeyRange(lower, upper, lowerOpen, upperOpen);
};

// Create a key range with a single key (static).
IDBKeyRange.only = function(value) {
  // Checks.
  if (!validKey(value)) {
    throw new DOMException('only(): value must be a valid key (string, number, date)', 'DataError');
  }

  // Make an IDBKeyRange and return it.
  return new IDBKeyRange(value, value, false, false);
};

// Create a key range with a lower bound but no upper bound (static).
IDBKeyRange.lowerBound = function(value, open = false) {
  // Checks.
  if (!validKey(value)) {
    throw new DOMException('lowerBound(): value must be a valid key (string, number, date)', 'DataError');
  }
  if (typeof open !== 'boolean') {
    throw new DOMException('lowerBound(): open must be boolean', 'DataError');
  }

  // Make an IDBKeyRange and return it.
  return new IDBKeyRange(value, undefined, open, true);
};

// Create a key range with an upper bound but no lower bound (static).
IDBKeyRange.upperBound = function(value, open = false) {
  // Checks.
  if (!validKey(value)) {
    throw new DOMException('upperBound(): value must be a valid key (string, number, date)', 'DataError');
  }
  if (typeof open !== 'boolean') {
    throw new DOMException('upperBound(): open must be boolean', 'DataError');
  }

  // Make an IDBKeyRange and return it.
  return new IDBKeyRange(undefined, value, true, open);
};

// IDBVersionChangeEvent mock.
class IDBVersionChangeEvent extends Event {
  // Construct.
  constructor(name, oldVersion, newVersion) {
    // Check.
    if (typeof name !== 'string') {
      throw new TypeError('IDBVersionChangeEvent: name must be string');
    }
    if (typeof oldVersion !== 'number' && oldVersion !== 0) {
      throw new TypeError('IDBVersionChangeEvent: oldVersion must be number');
    }
    if (typeof newVersion !== 'number') {
      throw new TypeError('IDBVersionChangeEvent: newVersion must be number');
    }

    // Super.
    super(name, {bubbles: false, cancelable: false});

    // Public.
    Object.defineProperty(this, 'oldVersion', {value: oldVersion, enumerable: true});
    Object.defineProperty(this, 'newVersion', {value: newVersion, enumerable: true});

    // Lock it down.
    Object.freeze(this);
  }
}

// DOMException mock.
// Name should be one of e.g. AbortError, ConstraintError, QuotaExceededError, UnknownError, NoError, VersionError
class DOMException extends Error {
  // Construct.
  constructor(message = '', name = '') {
    // Super.
    super(message);

    // Check.
    if (typeof name !== 'string') {
      throw new TypeError('DOMException: name must be string');
    }

    // Properties.
    Object.defineProperty(this, 'name', {value: name});
  }
}

// Functions.

// Reset data.
function reset() {
  // Delete everything.
  for (const key in connections) {
    delete connections[key];
  }
  for (const key in versions) {
    delete versions[key];
  }
  for (const key in storage) {
    delete storage[key];
  }
}

// Is the supplied identified a valid identifier?
const r_identifier = /^[a-z_][a-zA-Z0-9_\-$]*$/;
function validIdentifier(identifier) {
  if (typeof identifier === 'string' && identifier.match(r_identifier)) return true;
  else return false;
}

// Is the supplied key a valid keyPath?
// e.g. 'id' or 'abc' or 'abc.def'
function validKeyPath(keyPath) {
  if (typeof keyPath === 'string') {
    // Can be either 'abc' or 'abc.def'.
    const keyPathParts = keyPath.split('.');
    for (let i = 0; i < keyPathParts.length; i++) if (!validIdentifier(keyPathParts[i])) return false;
    return true;
  } else return false;
}

// Is the supplied array an array of valid key paths?
// e.g. ['id', 'abc', 'abc.def']
function validMultiKeyPath(keyPath) {
  if (keyPath instanceof Array) {
    // An array of otherwise valid single key paths.
    if (keyPath.length < 1) return false;
    for (let i = 0; i < keyPath.length; i++) if (!validKeyPath(keyPath[i])) return false;
    return true;
  } else return false;
}

// Valid version number.
function validVersion(version) {
  // Must be a round finite number that's more than 1.
  if (typeof version === 'number' && version > 0 && isFinite(version) && version === Math.round(version)) return true;
  else return false;
}

// Is the supplied key a valid key?
function validKey(key) {
  // Simple keys.
  if (typeof key === 'number' && isFinite(key)) return true;
  else if (typeof key === 'string') return true;
  else if (key instanceof Date) return true;
  return false;
}

// Is the supplied key a valid key range?
function validKeyRange(key) {
  if (key instanceof Array) {
    if (key.length < 1) return false;
    for (let i = 0; i < key.length; i++) if (!validKey(key[i]) && !validKeyRange(key[i])) return false;
    return true;
  }
  if (key instanceof IDBKeyRange) return true;
  return false;
}

// Is the key in the key range?
function keyInRange(key, range) {
  // Primitive ranges use simple comparisons.
  if (typeof range === 'number' || typeof range === 'string') return key === range;

  // Array ranges just test existance.
  if (range instanceof Array) {
    for (let i = 0; i < range.length; i++) if (keyInRange(key, range[i])) return true;
    return false;
  }

  // IDBKeyRanges test the key being inside the higher and lower range.
  if (range instanceof IDBKeyRange) return range.includes(key);

  // Anything else is false.
  return false;
}

// Deep clone a value.
function clone(value) {
  // Switch on type.
  if (value instanceof Array) {
    // Don't work on non-plain arrays.
    if (value.constructor !== Array) {
      throw new Error('clone() can only clone plain arrays');
    }

    // Quickly deep clone plain arrays by recursively calling clone() via map()
    return value.map(clone);
  } else if (value instanceof Object) {
    // Don't work on non-plain objects.
    if (value.constructor !== Object) {
      // TODO(philipwalton): temporarily allow copying this by reference
      // since IndexedDB supports storing things like Blobs.
      // https://github.com/dhoulb/shelving-mock-indexeddb/issues/2
      return value;
      // throw new Error('clone() can only clone plain objects');
    }

    // Deep clone the object.
    const cloned = {};
    for (const i in value) cloned[i] = clone(value[i]);
    return cloned;
  } else if (typeof value === 'number') {
    // Finite numbers only.
    // Things like Infinity and NaN are not
    if (!isFinite(value)) {
      throw new Error('clone() cannot clone non-finite number');
    }

    // No need to clone primative numbers.
    return value;
  } else if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
    // No need to clone primitive strings, booleans, or null.
    return value;
  } else {
    // Don't work with undefined.
    throw new Error('clone() can only clone JSON-friendly values (null, true, false, string, finite number, plain object, plain array)');
  }
}

// Exports.
module.exports.IDBFactory = IDBFactory;
module.exports.IDBDatabase = IDBDatabase;
module.exports.IDBTransaction = IDBTransaction;
module.exports.IDBRequest = IDBRequest;
module.exports.IDBOpenDBRequest = IDBOpenDBRequest;
module.exports.IDBObjectStore = IDBObjectStore;
module.exports.IDBIndex = IDBIndex;
module.exports.IDBCursor = IDBCursor;
module.exports.IDBCursorWithValue = IDBCursorWithValue;
module.exports.IDBKeyRange = IDBKeyRange;
module.exports.IDBVersionChangeEvent = IDBVersionChangeEvent;
module.exports.DOMException = DOMException;
module.exports.validIdentifier = validIdentifier;
module.exports.validKeyPath = validKeyPath;
module.exports.validMultiKeyPath = validMultiKeyPath;
module.exports.validVersion = validVersion;
module.exports.validKey = validKey;
module.exports.validKeyRange = validKeyRange;
module.exports.keyInRange = keyInRange;
module.exports.clone = clone;
module.exports.reset = reset;
