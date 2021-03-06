function fetchTalks(callback) {
  if (navigator.offLine) {
    callback();
    return;
  }
  chrome.storage.local.get(null, function(localMetadata) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'http://feeds.feedburner.com/tedtalksHD');
    xhr.onload = function() {
      var worker;
      var items = parseFeed(xhr.responseXML);
      for (var item of items) {

        // TODO: Remove .mp4 suffix when crbug.com/446435 is fixed.
        var title = item.title + '.mp4';
        var metadata = {};
        metadata['/' + title] = localMetadata['/' + title] ? localMetadata['/' + title] : {};

        metadata['/' + title].isDirectory = false;
        metadata['/' + title].name = title;
        metadata['/' + title].size = parseInt(item.enclosure.length);
        metadata['/' + title].modificationTime = item.pubDate;
        metadata['/' + title].mimeType = item.enclosure.type;
        metadata['/' + title].imageUrl = item.imageUrl;
        metadata['/' + title].url = item.enclosure.url;

        // Save talk metadata locally.
        chrome.storage.local.set(metadata);

        // Fetch thumbnail if we don't have it already.
        if (!metadata['/' + title].thumbnail) {
          // Create worker if it's not already done.
          if (typeof(worker) === "undefined") {
            var worker = new Worker('fetch-thumbnail.js');
            worker.addEventListener('message', function(e) {
              var updatedMetadata = e.data;
              chrome.storage.local.set(updatedMetadata);
            });
          }
          worker.postMessage(metadata);
        }
      }
      callback();
    }
    xhr.onerror = callback;
    xhr.send();
  });
}

function sanitizeMetadata(metadata) {
  metadata.modificationTime = new Date(metadata.modificationTime);
  return metadata;
}

function onGetMetadataRequested(options, onSuccess, onError) {
  console.log('onGetMetadataRequested', options.entryPath);

  chrome.storage.local.get(options.entryPath, function(localMetadata) {
    var metadata = localMetadata[options.entryPath];
    if (!metadata) {
      onError('NOT_FOUND');
    } else {
      // If no thumbnail is requested, make sure metadata don't include one.
      if (!options.thumbnail) {
        delete(metadata.thumbnail);
      }
      onSuccess(sanitizeMetadata(metadata));
    }
  });
}

function onReadDirectoryRequested(options, onSuccess, onError) {
  console.log('onReadDirectoryRequested', options);
  fetchTalks(function(){
    // TODO: Remove ugly code below.
    chrome.storage.local.get(null, function(localMetadata) {
      var videos = Object.keys(localMetadata).filter(function(entryPath) { return (entryPath !== '/'); }).map(function(entryPath) { return sanitizeMetadata(localMetadata[entryPath]); });
      onSuccess(videos, false /* last call. */);
    });
  });
}

// A map with currently opened files. As key it has requestId of
// openFileRequested and as a value the file path.
var openedFiles = {};

function onOpenFileRequested(options, onSuccess, onError) {
  console.log('onOpenFileRequested', options);
  if (options.mode != 'READ' || options.create) {
    onError('INVALID_OPERATION');
  } else {
    chrome.storage.local.get(null, function(metadata) {
      openedFiles[options.requestId] = options.filePath;
      onSuccess();
    });
  }
}

function onReadFileRequested(options, onSuccess, onError) {
  console.log('onReadFileRequested', options);
  chrome.storage.local.get(null, function(localMetadata) {
    var filePath = openedFiles[options.openRequestId];
    if (!filePath) {
      onError('SECURITY');
      return;
    }

    var xhr = new XMLHttpRequest();
    xhr.open('GET', localMetadata[filePath].url);
    xhr.setRequestHeader('Range', 'bytes=' + options.offset + '-' + (options.length + options.offset - 1));
    xhr.responseType = 'arraybuffer';
    xhr.onload = function() {
      if (xhr.readyState === 4 && xhr.status === 206) {
        onSuccess(xhr.response, false /* last call */);
        if (localMetadata[filePath].url !== xhr.responseURL) {
          var metadata = {};
          metadata[filePath] = localMetadata[filePath];
          metadata[filePath].url = xhr.responseURL;
          chrome.storage.local.set(metadata);
        }
      } else {
        onError('NOT_FOUND');
      }
    }
    xhr.onerror = function() {
      onError('NOT_FOUND');
    }
    xhr.send();
  });
}

function onCloseFileRequested(options, onSuccess, onError) {
  console.log('onCloseFileRequested', options);
  if (!openedFiles[options.openRequestId]) {
    onError('INVALID_OPERATION');
    return;
  }

  delete openedFiles[options.openRequestId];
  onSuccess();
}

function onMountRequested(options, onSuccess, onError) {
  console.log('onMountRequested', options);

  mountFileSystem();
  onSuccess();
}

function onUnmountRequested(options, onSuccess, onError) {
  console.log('onUnmountRequested', options);

  chrome.fileSystemProvider.unmount({ fileSystemId: options.fileSystemId });
  onSuccess();
}

function mountFileSystem() {
  // Clear stale metadata first.
  chrome.storage.local.clear(function() {
    // Save root metadata.
    chrome.storage.local.set({'/': {
      isDirectory: true,
      name: '',
      size: 0,
      modificationTime: new Date().toString()
    }});

    // Mount the file system.
    var options = { fileSystemId: 'tedtalks', displayName: 'TED Talks' };
    chrome.fileSystemProvider.mount(options, function() {
      if (!chrome.runtime.lastError)
        fetchTalks(function(){});
    });
  });
}


chrome.fileSystemProvider.onGetMetadataRequested.addListener(onGetMetadataRequested);
chrome.fileSystemProvider.onReadDirectoryRequested.addListener(onReadDirectoryRequested);
chrome.fileSystemProvider.onOpenFileRequested.addListener(onOpenFileRequested);
chrome.fileSystemProvider.onReadFileRequested.addListener(onReadFileRequested);
chrome.fileSystemProvider.onCloseFileRequested.addListener(onCloseFileRequested);
chrome.fileSystemProvider.onMountRequested && chrome.fileSystemProvider.onMountRequested.addListener(onMountRequested);
chrome.fileSystemProvider.onUnmountRequested.addListener(onUnmountRequested);

mountFileSystem();
