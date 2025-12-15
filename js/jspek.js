const byId = i =>
	/** @type {!HTMLElement} */(document.querySelector("#" + i));

let WRK = null, UID = 0;

/**
 * @param {string} typ
 * @param {WJSpek} dat
 * @param {(ArrayBuffer|OffscreenCanvas)=} trs
 */
const send = (typ, dat = {}, trs) =>
	WRK.postMessage(
		{
			type: typ,
			...dat
		},
		[...(!!trs ? [trs] : [])]
	);

const Parsers = {
	// Read 4 bytes as string
	get4cc: (v, i) =>
		String.fromCharCode(
			v.getUint8(i),
			v.getUint8(i + 1),
			v.getUint8(i + 2),
			v.getUint8(i + 3)
		),

	// FLAC (Fixed offsets)
	flac: v =>
		({
			cdc: "FLAC",
			spr: (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4),
			chn: ((v.getUint8(20) >> 1) & 7) + 1,
			btd: ((v.getUint8(20) & 1) << 4 | v.getUint8(21) >> 4) + 1
		}),

	// WAV (Chunk walker)
	wav: v => {

		let p = 12, meta = {
			cdc: "WAV",
			pcm: true
		};

		while(p < v.byteLength - 8) {

			const cid = v.getUint32(p), csz = v.getUint32(
				p + 4,
				true
			);

			if(cid === 0x666d7420) { // 'fmt '

				const tag = v.getUint16(
					p + 8,
					true
				);

				meta.cdc = tag === 3 ? "WAV (Float)" : "WAV (PCM)";
				meta.chn = v.getUint16(
					p + 10,
					true
				);
				meta.spr = v.getUint32(
					p + 12,
					true
				);
				meta.btd = v.getUint16(
					p + 22,
					true
				);
				break;
			
			}

			p += 8 + csz;
		
		}

		return meta;
	
	},

	// AIFF (Chunk walker)
	aiff: v => {

		let p = 12, meta = {
			cdc: "AIFF",
			pcm: true
		};

		while(p < v.byteLength - 8) {

			const cid = v.getUint32(p), csz = v.getUint32(p + 4);

			if(cid === 0x434F4D4D) { // 'COMM'

				meta.chn = v.getInt16(p + 8);
				meta.btd = v.getInt16(p + 14);
				const exp = v.getUint16(p + 16) & 0x7FFF;
				const mant = v.getUint32(p + 18);

				if(exp > 0)
					meta.spr = mant * Math.pow(
						2,
						exp - 16383 - 31
					);

				break;
			
			}

			p += 8 + ((csz + 1) & ~1);
		
		}

		return meta;
	
	},

	// MP3 (ID3 Skipper & Frame Header)
	mp3: v => {

		let offset = 0;

		// Skip ID3v2 if present
		if((v.getUint32(0) >>> 8) === 0x494433) {

			const size = (v.getUint8(6) << 21) | (v.getUint8(7) << 14) | (v.getUint8(8) << 7) | v.getUint8(9);

			offset = 10 + size;
		
		}
		
		// Find Sync
		if(offset < v.byteLength - 4) {

			const head = v.getUint32(offset);

			if(((head >>> 21) & 0x7FF) === 0x7FF) {

				const ver = (head >>> 19) & 3, srIdx = (head >>> 10) & 3;
				const rates = {
					3: [44100, 48000, 32000],
					2: [22050, 24000, 16000],
					0: [11025, 12000, 8000]
				};

				return {
					cdc: "MP3",
					spr: rates[ver]?.[srIdx] || 44100
				};
			
			}
		
		}

		return {
			cdc: "MP3"
		};
	
	},

	// OGG (Page parsing)
	ogg: v => {

		const nsegs = v.getUint8(26), head = 27 + nsegs;
		const sig = v.getUint32(head + 1);

		if(v.getUint8(head) === 0x01 && sig === 0x766F7262) {

			return {
				cdc: "Vorbis",
				chn: v.getUint8(head + 11),
				spr: v.getUint32(
					head + 12,
					true
				)
			};
		
		}
		else if(v.getUint32(head) === 0x4F707573) {

			return {
				cdc: "Opus",
				chn: v.getUint8(head + 9),
				spr: v.getUint32(
					head + 12,
					true
				)
			};
		
		}

		return {
			cdc: "OGG"
		};
	
	},

	// MP4/AAC (Atom Walker)
	mp4: v => {

		let meta = {
			cdc: "AAC",
			pcm: false
		};
		const find = (p, end, cb) => {

			while(p < end - 8) {

				const sz = v.getUint32(p);

				if(sz < 8 || p + sz > end)
					break;

				if(cb(
					Parsers.get4cc(
						v,
						p + 4
					),
					p,
					sz
				))
					return true;

				p += sz;
			
			}
		
		};
		const walk = (start, max) => {

			find(
				start,
				max,
				(nm, p, sz) => {

					if(["moov", "trak", "mdia", "minf", "stbl", "stsd"].includes(nm))
						return walk(
							p + (nm === "stsd" ? 16 : 8),
							p + sz
						);

					if(nm === "alac") {

						meta.cdc = "ALAC";
						meta.pcm = true;
						meta.chn = v.getUint16(p + 24);
						meta.btd = v.getUint16(p + 26);
						meta.spr = v.getUint32(p + 32) >>> 16;
						// ALAC Cookie
						const head = v.getUint16(p + 16) === 1 ? 52 : 36;

						find(
							p + head,
							p + sz,
							(snm, sp) => {

								if(snm === "alac") {

									meta.btd = v.getUint8(sp + 17);
									meta.chn = v.getUint8(sp + 21);
									meta.spr = v.getUint32(sp + 32);

									return true;
						
								}
					
							}
						);

						return true;
				
					}

					if(nm === "mp4a") {

						meta.chn = v.getUint16(p + 24);
						meta.spr = v.getUint32(p + 32) >>> 16;

						return true;
				
					}
			
				}
			);
		
		};

		walk(
			0,
			v.byteLength
		);

		return meta;
	
	},
	
	ape: v =>
		({
			cdc: "APE"
		})
};

class JSpek {

	constructor(f, main) {

		this.main = main;
		this.uid = ++UID;
		this.dpr = window.devicePixelRatio || 1;
		this.buf = false;
		this.dat = {
			nnm: f.name,
			inf: "Loading"
		};
		this.lay = {
			x: 0,
			y: 0,
			w: 0,
			h: 0,
			fw: 0,
			fh: 0
		};
		this.zoom = 1;
		this.pan = 0;
		this.ori = 0;
		this.drg = false;
		this.did = false;
		this.frm = null;

		this.elt = document.createElement("div");
		this.elt.className = "spek";
		this.cvs = document.createElement("canvas");
		this.elt.append(this.cvs);
		main.wrp.append(this.elt);

		const off = this.cvs.transferControlToOffscreen();

		send(
			"init",
			{
				uid: this.uid,
				cvs: off
			},
			off
		);

		this.bindEvents();
		this.load(f);
	
	}

	bindEvents() {

		const onDown = e => {

			if(!this.buf || this.zoom === 1)
				return;

			this.drg = true;
			this.did = false;
			this.cvs.setPointerCapture(e.pointerId);
			const rect = this.cvs.getBoundingClientRect();

			this.ori = this.pan + (((e.clientX - rect.left) * this.dpr - this.lay.x) / this.lay.w) * (1 / this.zoom);
		
		};

		const onMove = e => {

			if(!this.drg)
				return;

			this.did = true;
			const rect = this.cvs.getBoundingClientRect();
			const viewSize = 1 / this.zoom;
			const pointerNorm = ((e.clientX - rect.left) * this.dpr - this.lay.x) / this.lay.w;

			this.pan = Math.max(
				0,
				Math.min(
					1 - viewSize,
					this.ori - pointerNorm * viewSize
				)
			);
			this.render(true);
			this.main.pan(
				this,
				true
			);
		
		};

		const onUp = e => {

			if(this.drg) {

				this.drg = false;
				this.cvs.releasePointerCapture(e.pointerId);
				this.render();
				this.main.pan(
					this,
					false
				);
			
			}
		
		};

		this.cvs.onpointerdown = onDown;
		this.cvs.onpointermove = onMove;
		this.cvs.onpointerup = onUp;
		this.cvs.onpointercancel = onUp;
	
	}

	destroy() {

		if(this.frm)
			cancelAnimationFrame(this.frm);

		send(
			"destroy",
			{
				uid: this.uid
			}
		);

		this.elt.remove();
	
	}

	layout() {

		const d = this.dpr, w = this.elt.clientWidth, h = this.elt.clientHeight;
		const fw = Math.floor(w * d), fh = Math.floor(h * d);

		this.lay = {
			x: Math.floor(24 * d),
			y: Math.floor(36 * d),
			w: Math.floor(fw - 56 * d),
			h: Math.floor(fh - 54 * d),
			fw,
			fh
		};
		this.render();
	
	}

	parseMetadata(f, ab) {

		const v = new DataView(ab);
		const meta = {
			spr: 44100,
			chn: 2,
			btd: 0,
			pcm: false,
			cdc: "?"
		};
		
		if(ab.byteLength < 12)
			return meta;

		const ext = f.name.slice(f.name.lastIndexOf(".") + 1);
		let typ = f.type || ext || "";

		// Fallback: Detect type by signature if MIME is generic or missing
		/*
		const id32 = v.getUint32(0);
		if(!typ || typ === "application/octet-stream") {

			const sigs = {
				0x4D414320: "audio/ape",
				0x52494646: "audio/wav",
				0x464F524D: "audio/aiff",
				0x664C6143: "audio/flac",
				0x4F676753: "audio/ogg"
			};

			typ = sigs[id32] || typ;

			if((id32 >>> 8) === 0x494433 || (v.getUint16(0) & 0xFFE0) === 0xFFE0)
				typ = "audio/mp3";
			else if([0x66747970, 0x4D344120, 0x6D6F6F76].includes(v.getUint32(4)))
				typ = "audio/mp4";
		
		}*/

		try {

			const map = {
				"wav": Parsers.wav,
				"aiff": Parsers.aiff,
				"flac": Parsers.flac,
				"ogg": Parsers.ogg,
				"mp4": Parsers.mp4,
				"m4a": Parsers.mp4,
				"aac": Parsers.mp4,
				"adts": Parsers.mp4,
				"mp3": Parsers.mp3,
				"mpeg": Parsers.mp3,
				"ape": Parsers.ape
			};
			
			const key = Object.keys(map)
			.find(k =>
				typ.includes(k));

			if(key)
				Object.assign(
					meta,
					map[key](v)
				);
		
		}
		catch(err) {

			console.error(
				"meta fail",
				err
			);
		
		}

		return meta;
	
	}

	async load(f) {

		try {

			const ab = await f.arrayBuffer();
			const meta = this.parseMetadata(
				f,
				ab
			);
			const mib = f.size / 1048576;
			
			let dec;

			try {

				const ctx = new OfflineAudioContext(
					1,
					1,
					meta.spr
				);

				dec = await ctx.decodeAudioData(ab);
			
			}
			catch(err) {

				throw new Error(`${meta.cdc} unsupported`);
			
			}
            
			this.buf = true;
			let kbps = (meta.pcm && meta.btd && meta.spr)
				? Math.round(meta.spr * meta.chn * meta.btd / 1000)
				: Math.round(f.size * 8 / dec.duration / 1000);

			this.dat.inf = `${meta.cdc} ${Math.round(dec.sampleRate / 1e3)}kHz${meta.btd ? " " + meta.btd + "bit" : ""} ${dec.numberOfChannels}ch ${this.fmt(dec.duration)} ${kbps}kbps ${mib >= 1 ? mib.toFixed(2) + "MB" : (f.size / 1024).toFixed(1) + "KB"}`;
            
			const chn = dec.getChannelData(0);

			send(
				"audio",
				{
					uid: this.uid,
					chn: chn,
					spr: dec.sampleRate
				},
				chn.buffer
			);
		
		}
		catch(err) {

			this.dat.inf = "Error: " + err.message;
		
		}
		this.render();
	
	}

	render(drg = false) {

		if(this.frm)
			return;

		this.frm = requestAnimationFrame(() => {

			send(
				"render",
				{
					uid: this.uid,
					lay: this.lay,
					zoom: this.zoom,
					pan: this.pan,
					dpr: this.dpr,
					dat: this.dat,
					drg: drg,
					log: this.main.low
				}
			);

			this.frm = null;
		
		});
	
	}

	resetZoom() {

		if(this.buf) {

			this.zoom = 1;
			this.pan = 0;
			this.render();
		
		}
	
	}
    
	setZoom(fact) {

		if(!this.buf)
			return;

		const nz = Math.max(
			1,
			Math.min(
				64,
				this.zoom * fact
			)
		);

		if(nz === this.zoom)
			return;

		const center = this.pan + (1 / this.zoom) / 2;

		this.zoom = nz;
		this.pan = Math.max(
			0,
			Math.min(
				1 - 1 / nz,
				center - (1 / nz) / 2
			)
		);
		this.render();
	
	}
    
	fmt(s) {

		return [Math.floor(s / 60), Math.floor(s % 60)].map(v =>
			(v + "").padStart(
				2,
				"0"
			))
		.join(":");
	
	}

}

class JSpekManager {

	constructor() {

		this.speks = new Set();
		this.wrp = byId("wrp");
		this.tls = byId("tools");
		this.fin = byId("files");
		this.cur = new Set();
		this.tid = null;
		this.snc = false;
		this.low = false;
		this.cols = 0;
		this.rows = 0;

		WRK = new Worker(`js/jspek.worker${DEBUG ? "" : ".release.min"}.js`);
		WRK.onmessage = evt => {

			if(evt.data.type === "export")
				this.dl(evt.data.data);
		
		};

		this.fin.onchange = () =>
			this.add(this.fin.files);
		document.body.ondragover = e =>
			e.preventDefault();
		document.body.ondrop = e => {

			e.preventDefault();
			this.add(e.dataTransfer.files);
		
		};
		window.onresize = () => {

			clearTimeout(this.tid);
			this.tid = setTimeout(
				() =>
					this.draw(true),
				123
			);
		
		};

		Object.entries({
			"browse": () =>
				this.fin.click(),
			"export": () =>
				send("export"),
			"clear": () => {

				this.speks.forEach(s =>
					s.destroy());
					
				this.speks.clear();

			},
			"select": () =>
				this.slct(),
			"sync": () =>
				this.sync(),
			"low": () =>
				this.lows(),
			"zoomin": () =>
				this.cur.forEach(s =>
					s.setZoom(2)),
			"zoomout": () =>
				this.cur.forEach(s =>
					s.setZoom(.5)),
			"reset": () =>
				this.cur.forEach(s =>
					s.resetZoom()),
			"remove": () =>
				this.cur.forEach(s =>
					this.rem(s))
		})
		.forEach(([k, fn]) =>
			byId(k).onclick = fn);
	
	}

	add(files) {

		[...files].forEach(f => {

			const inst = new JSpek(
				f,
				this
			);

			this.speks.add(inst);
			inst.elt.onclick = () => {

				if(inst.did) {

					inst.did = false;

					return;

				}

				this.tgl(inst);
			
			};
		
		});
		this.draw(true);

		if(this.speks.size === 1)
			this.all();
	
	}

	rem(inst) {

		this.cur.delete(inst);
		inst.destroy();
		this.speks.delete(inst);
		this.draw();

		if(this.speks.size === 1)
			this.all();
	
	}

	tgl(inst) {

		if(this.cur.has(inst))
			this.blr(inst);
		else
			this.sel(inst);
	
	}

	slct() {

		if(this.cur.size > this.speks.size / 2)
			this.non();
		else
			this.all();
	
	}

	all() {

		this.speks.forEach(s => {

			if(s.buf)
				this.sel(s);

		});
	
	}

	non() {

		this.speks.forEach(s =>
			this.blr(s));
	
	}

	sel(inst) {

		if(!this.cur.size)
			this.tls.classList.remove("nope");

		this.cur.add(inst);
		inst.elt.classList.add("fcs");
	
	}

	blr(inst) {

		inst.elt.classList.remove("fcs");
		this.cur.delete(inst);

		if(!this.cur.size)
			this.tls.classList.add("nope");
	
	}

	sync() {

		this.snc = !this.snc;
		byId("sync").classList.toggle(
			"actv",
			this.snc
		);
	
	}

	lows() {

		this.low = !this.low;
		byId("low").classList.toggle(
			"actv",
			this.low
		);
		this.speks.forEach(s =>
			s.render());
	
	}

	pan(inst, drg) {

		if(this.snc) {

			this.cur.forEach(s => {

				if(s.uid !== inst.uid) {

					s.pan = inst.pan;
					s.render(drg);
				
				}
			
			});
		
		}
	
	}

	draw(target = false) {

		const n = this.speks.size;

		if(!n)
			return;

		const cols = Math.ceil(Math.sqrt(n)), rows = Math.ceil(n / cols);

		this.wrp.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
		this.wrp.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

		if(target === true || (cols !== this.cols || rows !== this.rows))
			this.speks.forEach(s =>
				s.layout());
		else if(target)
			target.layout();

		this.cols = cols;
		this.rows = rows;
	
	}

	dl(ab) {

		const blb = new Blob(
			[ab],
			{
				type: "image/png"
			}
		);
		const u = URL.createObjectURL(blb), a = document.createElement("a");

		a.download = `jspek_${Date.now()}.png`;
		a.href = u;
		a.click();
		URL.revokeObjectURL(u);
	
	}

}

window.onload = () =>
	new JSpekManager();