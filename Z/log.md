压缩2.2m视频 成功
但是  原始 2.2 MB → 压缩后 3.4 MB 节省 -55%  速率 1-2m/s
日志如下
processor.ts:20 📁 [Processor] Init
logger.ts:50 ✅ [Storage] OPFS Access Granted.
logger.ts:50 ✅ OPFS Ready
logger.ts:50 ✅ [Processor] Worker Handshake OK
media-worker.ts:45 🚀 [Worker] Pipeline Start
media-worker.ts:89 📖 [Worker] Phase 1: Feeding until onReady...
media-worker.ts:67 ✅ [Worker] onReady fired
media-worker.ts:76 📹 [Worker] Video track: id=1, codec=avc1.4d001f, 1176x696
media-worker.ts:80 ✅ [Worker] Extraction started
media-worker.ts:106 ✅ [Worker] Phase 1 complete
media-worker.ts:109 🔧 [Worker] Extracting avcC from mp4box.boxes...
media-worker.ts:265 🔍 [Worker] Found mp4box.boxes array, length: 4
media-worker.ts:333 🔍 [Worker] Found matching trak, id= 1
media-worker.ts:370 🔍 [Worker] Found stsd, entries: 1
media-worker.ts:378 🔍 [Worker] Entry type: avc1
media-worker.ts:382 🔍 [Worker] Found video sample entry, checking its boxes...
media-worker.ts:385 🔍 [Worker] Entry has 1 sub-boxes
media-worker.ts:388 🔍 [Worker] Sub-box type: avcC
media-worker.ts:391 ✅ [Worker] Found avcC/hvcC in entry.boxes!
media-worker.ts:418 🔍 [Worker] extractAVCCData, box has start: 2321974 size: 60
media-worker.ts:434 🔍 [Worker] Using DataStream.write() to serialize avcC box
media-worker.ts:441 ✅ [Worker] avcC serialized, length: 52
media-worker.ts:268 ✅ [Worker] Found avcC in mp4box.boxes
media-worker.ts:111 🔧 [Worker] Description: present (52 bytes)
media-worker.ts:114 📖 [Worker] Phase 2: Re-feeding all data...
media-worker.ts:129 ✅ [Worker] Phase 2 complete: 182 samples extracted
media-worker.ts:164 🔧 [Worker] Checking hardware encoder support...
media-worker.ts:169 ✅ [Worker] Hardware encoder supported
media-worker.ts:200 ✅ [Worker] Encoder configured
media-worker.ts:220 ✅ [Worker] Decoder configured
media-worker.ts:222 🎬 [Worker] Processing 182 frames...
media-worker.ts:239 ✅ [Worker] Encode complete: 182/182 frames
media-worker.ts:251 🎉 [Worker] Pipeline Complete
logger.ts:50 🎉 [Processor] Complete

压缩26m视频 成功 速率2-3 m/s

原始 27.0 MB → 压缩后 16.4 MB 节省 39%

 [Processor] Init
logger.ts:50 ✅ [Storage] OPFS Access Granted.
logger.ts:50 ✅ OPFS Ready
logger.ts:50 ✅ [Processor] Worker Handshake OK
media-worker.ts:45 🚀 [Worker] Pipeline Start
media-worker.ts:89 📖 [Worker] Phase 1: Feeding until onReady...
media-worker.ts:67 ✅ [Worker] onReady fired
media-worker.ts:76 📹 [Worker] Video track: id=1, codec=avc1.4d0020, 1002x962
media-worker.ts:80 ✅ [Worker] Extraction started
media-worker.ts:106 ✅ [Worker] Phase 1 complete
media-worker.ts:109 🔧 [Worker] Extracting avcC from mp4box.boxes...
media-worker.ts:265 🔍 [Worker] Found mp4box.boxes array, length: 4
media-worker.ts:333 🔍 [Worker] Found matching trak, id= 1
media-worker.ts:370 🔍 [Worker] Found stsd, entries: 1
media-worker.ts:378 🔍 [Worker] Entry type: avc1
media-worker.ts:382 🔍 [Worker] Found video sample entry, checking its boxes...
media-worker.ts:385 🔍 [Worker] Entry has 1 sub-boxes
media-worker.ts:388 🔍 [Worker] Sub-box type: avcC
media-worker.ts:391 ✅ [Worker] Found avcC/hvcC in entry.boxes!
media-worker.ts:418 🔍 [Worker] extractAVCCData, box has start: 28267585 size: 60
media-worker.ts:434 🔍 [Worker] Using DataStream.write() to serialize avcC box
media-worker.ts:441 ✅ [Worker] avcC serialized, length: 52
media-worker.ts:268 ✅ [Worker] Found avcC in mp4box.boxes
media-worker.ts:111 🔧 [Worker] Description: present (52 bytes)
media-worker.ts:114 📖 [Worker] Phase 2: Re-feeding all data...
media-worker.ts:129 ✅ [Worker] Phase 2 complete: 1629 samples extracted
media-worker.ts:164 🔧 [Worker] Checking hardware encoder support...
media-worker.ts:169 ✅ [Worker] Hardware encoder supported
media-worker.ts:200 ✅ [Worker] Encoder configured
media-worker.ts:220 ✅ [Worker] Decoder configured
media-worker.ts:222 🎬 [Worker] Processing 1629 frames...
media-worker.ts:239 ✅ [Worker] Encode complete: 1629/1629 frames
media-worker.ts:251 🎉 [Worker] Pipeline Complete
logger.ts:50 🎉 [Processor] Complete