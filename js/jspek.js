const FFT_CACHE = {};

class FFT {

	static ctx(n) {

		if(FFT_CACHE[n])
			return FFT_CACHE[n];

		const bit = new Uint32Array(n);
		const cos = new Float32Array(n / 2);
		const sin = new Float32Array(n / 2);

		// Bit-Reversal
		for(let lim = 1, b = n >> 1; lim < n; lim <<= 1, b >>= 1)
			for(let i = 0; i < lim; i++)
				bit[i + lim] = bit[i] + b;

		// Precompute Tables
		const k = -2 * Math.PI / n;

		for(let i = 0; i < n / 2; i++) {

			cos[i] = Math.cos(k * i);
			sin[i] = Math.sin(k * i);
		
		}

		return FFT_CACHE[n] = {
			n, bit, cos, sin
		};
	
	}

	static calc({
		n, bit, cos, sin
	}, r, im) {

		// Bit-Reverse Permutation
		for(let i = 0; i < n; i++) {

			const j = bit[i];

			if(j > i) {

				const tr = r[i];

				r[i] = r[j];
				r[j] = tr;
				const ti = im[i];

				im[i] = im[j];
				im[j] = ti;
			
			}
		
		}

		// Cooley-Tukey Butterfly
		for(let size = 2; size <= n; size *= 2) {

			const half = size / 2;
			const step = n / size;

			for(let i = 0; i < n; i += size) {

				for(let j = 0; j < half; j++) {

					const idx = i + j;
					const idx2 = idx + half;
					const k = j * step;
					
					const c = cos[k];
					const s = sin[k];
					
					const tr = r[idx2] * c - im[idx2] * s;
					const ti = r[idx2] * s + im[idx2] * c;

					r[idx2] = r[idx] - tr;
					im[idx2] = im[idx] - ti;
					r[idx] += tr;
					im[idx] += ti;
				
				}
			
			}
		
		}
	
	}

}

const PAL = new Uint32Array(256);

for(let i = 0; i < 256; i++) {

	const x = i / 255;
	const r = x < .13 ? 0 : x < .73 ? Math.sin((x - .13) / .6 * Math.PI / 2) : 1;
	const g = x < .6 ? 0 : x < .91 ? Math.sin((x - .6) / .31 * Math.PI / 2) : 1;
	const b = x < .6 ? .5 * Math.sin(x / .6 * Math.PI) : x < .78 ? 0 : (x - .78) / .22;

	PAL[i] = 0xff000000 | (b * 255 << 16) | (g * 255 << 8) | (r * 255);

}

class JSpek {

	constructor(fil, app) {

		this.dpr = window.devicePixelRatio || 1;
		this.siz = 2048; // default size
		this.min = -120;
		this.max = 0;
		this.tck = 4 * this.dpr;
		this.buf = null;
		this.raf = null;
		this.dat = {
			nnm: "",
			inf: ""
		};
		this.lay = {};

		this.win = null;

		this.elt = document.createElement("div");
		this.elt.classList.add("spek");
		this.cvs = document.createElement("canvas");
		this.elt.append(this.cvs);
		this.ctx = /** @type {CanvasRenderingContext2D} */(this.cvs.getContext(
			"2d",
			{
				alpha: false
			}
		));
		app.append(this.elt);

		this.load(fil);
	
	}

	destroy() {

		this.stop();
		this.elt.remove();
	
	}

	up() {

		const d = this.dpr;
		
		const w = this.elt.clientWidth;
		const h = this.elt.clientHeight;
		
		const fw = Math.floor(w * d);
		const fh = Math.floor(h * d);

		this.cvs.width = fw;
		this.cvs.height = fh;

		this.lay = {
			x: Math.floor(40 * d),
			y: Math.floor(30 * d),
			w: Math.floor(fw - 96 * d),
			h: Math.floor(fh - 50 * d),
			fw: fw,
			fh: fh
		};

		if(this.buf)
			this.render();
		else
			this.ui();
	
	}

	async load(f) {

		this.dat = {
			nnm: f.name,
			inf: "Loading..."
		};
		this.ui();

		try {

			const raw = await f.arrayBuffer(), v = new DataView(raw);
			let sr = 44100, bd = null, p = 12;

			if(v.getUint32(0) === 0x52494646) {

				while(p < v.byteLength) {

					if(v.getUint32(p) === 0x666d7420) {

						sr = v.getUint32(
							p + 12,
							true
						);
						bd = v.getUint16(
							p + 22,
							true
						);
						break;
					
					}

					p += 8 + v.getUint32(
						p + 4,
						true
					);
				
				}
			
			}
			else if(v.getUint32(0) === 0x664c6143) {

				sr = (v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4);
				bd = ((v.getUint8(20) & 1) << 4 | v.getUint8(21) >> 4) + 1;
			
			}

			const dec = await new OfflineAudioContext(
				1,
				1,
				sr
			)
			.decodeAudioData(raw);
			
			// Dynamic FFT Size
			if(dec.sampleRate > 88200)
				this.siz = 8192;
			else if(dec.sampleRate > 44100)
				this.siz = 4096;
			else
				this.siz = 2048;

			this.win = new Float32Array(this.siz);

			// Periodic Hann Window
			for(let i = 0; i < this.siz; i++)
				this.win[i] = .5 * (1 - Math.cos(2 * Math.PI * i / this.siz));

			const dur = dec.duration, sz = f.size, mib = sz / 1048576;

			this.dat.inf = `${Math.round(dec.sampleRate / 1e3)}kHz${bd ? `  ${bd}bit` : ""}  ${dec.numberOfChannels}ch  ${this.fmt(dur)}  ${sz * 8 / dur / 1e3 | 0}kbps  ${mib >= 1 ? mib.toFixed(2) + "MB" : (sz / 1024).toFixed(1) + "KB"}`;
			this.buf = dec;
			this.render();
		
		}
		catch(err) {

			this.dat.inf = "Error : " + err.message;
			this.ui();
		
		}
	
	}

	ui() {

		const {
			ctx, lay: {
				fw, fh, x, y, w, h
			}, dpr, buf, dat, min, max
		} = this;

		if(!fw)
			return;

		const fnt = "system-ui";
		const col = "#757575";

		ctx.fillStyle = "#000";
		ctx.fillRect(
			0,
			0,
			fw,
			fh
		);

		ctx.fillStyle = col;

		ctx.font = `${13 * dpr}px ${fnt}`;
		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillText(
			dat.nnm,
			x,
			y / 2
		);

		const tx = x + ctx.measureText(dat.nnm).width + 10 * dpr;

		ctx.font = `${11 * dpr}px ${fnt}`;
		ctx.fillText(
			dat.inf,
			tx,
			y / 2
		);

		if(!buf)
			return;

		const fs = 10 * dpr;

		ctx.font = `${fs}px ${fnt}`;
		ctx.textAlign = "right";

		const nyq = buf.sampleRate / 2;
		const fStep = [1e3, 2e3, 5e3, 1e4, 2e4].find(s =>
			nyq / s <= 20) || 2e4;

		for(let f = 0; f <= nyq; f += fStep) {

			const py = y + h - f / nyq * h;

			if(py > y + fs && py < y + h - fs) {

				this.freq(
					x,
					py,
					f
				);
			
			}
		
		}
		this.freq(
			x,
			y - 1,
			nyq
		);
		
		this.freq(
			x,
			y + h,
			0
		);

		ctx.textAlign = "center";
		ctx.textBaseline = "top";
		const dur = buf.duration;
		const tStep = [1, 2, 5, 10, 30, 60, 120, 300, 600].find(s =>
			dur / s <= 20) || 600;

		for(let t = 0; t <= dur; t += tStep) {

			this.time(
				x + t / dur * w,
				y + h,
				t
			);
		
		}

		/*
		// last time
		this.time(
			x + w + 1,
			y + h,
			dur
		);
		*/

		const spc = 3 * dpr, dx = x + w + spc, dy = y - 1, sw = 12 * dpr, sh = h + 1;

		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		const grad = ctx.createImageData(
				sw,
				sh
			), g32 = new Uint32Array(grad.data.buffer);

		for(let py = 0; py < sh; py++) {

			const c = PAL[(1 - py / h) * 255 | 0];

			for(let i = 0; i < sw; i++)
				g32[py * sw + i] = c;
		
		}
		ctx.putImageData(
			grad,
			dx,
			dy
		);

		for(let db = min; db <= max; db += 10) {

			const py = y + h - (db - min) / (max - min) * sh;
			
			ctx.fillText(
				db + "dB",
				dx + sw + 6,
				py
			);
			ctx.fillRect(
				dx - spc,
				py,
				6,
				1
			);
		
		}

		ctx.strokeStyle = col;
		ctx.lineWidth = 1;
		ctx.strokeRect(
			x,
			y,
			w,
			h
		);
	
	}

	freq(x, y, v) {
		
		this.ctx.fillText(
			Math.round(v / 1e3) + "kHz",
			x - this.tck - 4,
			y
		);
		this.ctx.fillRect(
			x - this.tck,
			y,
			this.tck,
			1
		);
	
	}

	time(x, y, v) {

		this.ctx.fillText(
			this.fmt(v),
			x,
			y + this.tck + 4
		);
		this.ctx.fillRect(
			x - 1,
			y,
			1,
			this.tck
		);

	}

	stop() {

		if(this.raf) {

			cancelAnimationFrame(this.raf);
			this.raf = null;
		
		}
	
	}

	render() {

		this.stop();
		const {
			ctx, lay: {
				x, y, w, h
			}, buf, siz, win, min, max
		} = this;

		const ch = buf.getChannelData(0), len = ch.length, fft = FFT.ctx(siz);
		const bins = siz >> 1, step = len / w | 0;
		
		const norm = 20 * Math.log10(1 / siz);
		
		const real = new Float32Array(siz), imag = new Float32Array(siz);
		const img = ctx.createImageData(
				w,
				h
			), pix = new Uint32Array(img.data.buffer);
		const range = max - min;

		this.ui();
		let px = 0;

		const loop = () => {

			const start = px;

			for(let end = Math.min(
				px + 50,
				w
			); px < end; px++) {

				const off = (px * step) - bins;

				let dc = 0;
				let count = 0;

				for(let i = 0; i < siz; i++) {

					if(off + i >= 0 && off + i < len) {

						dc += ch[off + i];
						count++;
					
					}
				
				}

				if(count > 0)
					dc /= count;

				for(let i = 0; i < siz; i++) {

					const val = (off + i >= 0 && off + i < len) ? (ch[off + i] - dc) : 0;

					real[i] = val * win[i];
					imag[i] = 0;
				
				}
				
				FFT.calc(
					fft,
					real,
					imag
				);

				for(let row = 0; row < h; row++) {

					const b0 = (h - row - 1) / h * bins | 0, b1 = (h - row) / h * bins | 0;
					let peak = 0;

					for(let b = b0; b <= b1 && b < bins; b++) {

						const m = real[b] * real[b] + imag[b] * imag[b];

						if(m > peak)
							peak = m;
					
					}

					const db = 10 * Math.log10(peak + 1e-20) + norm;

					pix[row * w + px] = PAL[Math.max(
						0,
						Math.min(
							255,
							(db - min) / range * 255 | 0
						)
					)];

				}

			}
			ctx.putImageData(
				img,
				x,
				y,
				start,
				0,
				px - start,
				h
			);

			if(px < w)
				this.raf = requestAnimationFrame(loop);

		};

		this.raf = requestAnimationFrame(loop);

	}

	fmt(s) {

		return `${s / 60 | 0}:${(s % 60 | 0).toString()
		.padStart(
			2,
			"0"
		)}`;

	}

}

class JSpekManager {

	constructor() {

		this.instances = [];
		this.app = document.getElementById("app");
		this.tid = null;
		this.cols = 0;
		this.rows = 0;

		const fin = document.getElementById("f");

		const add = fs =>
			[...fs].forEach(f =>
				this.add(f));

		fin.onchange = () => {

			add(fin.files);
			fin.value = "";

		};
		document.body.ondragover = evt =>
			evt.preventDefault();

		document.body.ondrop = evt => {

			evt.preventDefault();

			add(evt.dataTransfer.files);

		};
		document.getElementById("browse").onclick = () =>
			fin.click();
		document.getElementById("save").onclick = () =>
			this.save();
		window.onresize = () => {

			clearTimeout(this.tid);

			this.tid = setTimeout(
				() =>
					this.draw(true),
				123
			);

		};
	
	}

	add(f) {

		const inst = new JSpek(
			f,
			this.app
		);

		this.instances.push(inst);
		this.draw(inst);

		inst.elt.addEventListener(
			"dblclick",
			() =>
				this.rem(inst),
			{
				once: true
			}
		);
	
	}

	rem(inst) {

		const i = this.instances.indexOf(inst);

		if(i > -1) {

			this.instances[i].destroy();
			this.instances.splice(
				i,
				1
			);
			this.draw();

		}
	
	}

	/**
	 * @param {!(boolean|JSpek)=} target
	 */
	draw(target = false) {

		const n = this.instances.length;

		if(!n)
			return;

		const cols = Math.ceil(Math.sqrt(n));
		const rows = Math.ceil(n / cols);

		this.app.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
		this.app.style.gridTemplateRows = `repeat(${rows}, 1fr)`;

		const chg = cols !== this.cols || rows !== this.rows;

		this.cols = cols;
		this.rows = rows;

		if(chg || target === true)
			this.upAll();
		else if(target instanceof JSpek)
			target.up();
	
	}

	upAll() {

		for(const s of this.instances)
			s.up();

	}

	save() {

		const cvss = this.instances.filter(inst =>
			!!inst.buf)
		.map(inst =>
			inst.cvs);

		if(!cvss.length)
			return;

		const maxSize = 4096;
	
		const {
			width, height
		} = cvss[0];
		const cols = Math.ceil(Math.sqrt(cvss.length));
		const rows = Math.ceil(cvss.length / cols);
		const scale = Math.min(
			1,
			maxSize / (cols * width),
			maxSize / (rows * height)
		);
	
		const sw = width * scale;
		const sh = height * scale;
	
		const off = new OffscreenCanvas(
			cols * sw,
			rows * sh
		);
		
		const ctx = /** @type {OffscreenCanvasRenderingContext2D} */(off.getContext(
			"2d",
			{
				alpha: false
			}
		));
	
		cvss.forEach((cvs, i) =>
			ctx.drawImage(
				cvs,
				(i % cols) * sw,
				Math.floor(i / cols) * sh,
				sw,
				sh
			));

		off.convertToBlob()
		.then(blb => {

			const u = URL.createObjectURL(blb);

			const a = document.createElement("a");

			a.download = `jspek_${Date.now()}.png`;
			a.href = u;
			a.click();
			URL.revokeObjectURL(u);
		
		});
	
	}

}

window.addEventListener(
	"load",
	() =>
		new JSpekManager()
);