/**
 * @define {boolean} DEBUG : verbose
 */
var DEBUG = true;

const FFT_CACHE = {};

const FFT = n => {

	if(FFT_CACHE[n])
		return FFT_CACHE[n];

	const bit = new Uint32Array(n), cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
	const k = -2 * Math.PI / n;

	for(let lim = 1, b = n >> 1; lim < n; lim <<= 1, b >>= 1)
		for(let i = 0; i < lim; i++)
			bit[i + lim] = bit[i] + b;

	for(let i = 0; i < n / 2; i++) {

		cos[i] = Math.cos(k * i);
		sin[i] = Math.sin(k * i);

	}

	return FFT_CACHE[n] = {
		n, bit, cos, sin
	};

};

const calcFFT = ({
	n, bit, cos, sin
}, r, im) => {

	for(let i = 0; i < n; i++) {

		const j = bit[i];

		if(j > i) {

			[r[i], r[j]] = [r[j], r[i]];
			[im[i], im[j]] = [im[j], im[i]];

		}
	
	}

	for(let size = 2; size <= n; size *= 2) {

		const half = size / 2, step = n / size;

		for(let i = 0; i < n; i += size) {

			for(let j = 0; j < half; j++) {

				const k = j * step, c = cos[k], s = sin[k];
				const idx = i + j, idx2 = idx + half;
				const tr = r[idx2] * c - im[idx2] * s, ti = r[idx2] * s + im[idx2] * c;

				r[idx2] = r[idx] - tr;
				im[idx2] = im[idx] - ti;
				r[idx] += tr;
				im[idx] += ti;
			
			}
		
		}
	
	}

};

const PAL = new Uint32Array(256);

for(let i = 0; i < 256; i++) {

	const x = i / 255;
	const r = x < .13 ? 0 : x < .73 ? Math.sin((x - .13) / .6 * Math.PI / 2) : 1;
	const g = x < .6 ? 0 : x < .91 ? Math.sin((x - .6) / .31 * Math.PI / 2) : 1;
	const b = x < .6 ? .5 * Math.sin(x / .6 * Math.PI) : x < .78 ? 0 : (x - .78) / .22;

	PAL[i] = 0xff000000 | (b * 255 << 16) | (g * 255 << 8) | (r * 255);

}

const speks = {}, temps = {};
const MIN_DB = -120, MAX_DB = 0, LOG_MIN = 20, LOG_MAX = 20000;

self.onmessage = evt => {

	const d = /** @type {WJSpek} */(evt.data);

	if(d.type === "init") {

		speks[d.uid] = {
			cvs: d.cvs,
			ctx: d.cvs.getContext(
				"2d",
				{
					alpha: false
				}
			),
			aud: null,
			siz: 2048,
			win: null
		};
	
	}
	else if(d.type === "destroy") {

		delete speks[d.uid];
		delete temps[d.uid];
	
	}
	else if(d.type === "audio") {

		const inst = speks[d.uid];

		if(inst) {

			inst.aud = {
				chn: d.chn,
				spr: d.spr,
				len: d.chn.length
			};
			const s = d.spr > 88200 ? 8192 : d.spr > 44100 ? 4096 : 2048;

			inst.siz = s;
			inst.win = new Float32Array(s);

			for(let i = 0; i < s; i++)
				inst.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / s));
		
		}
	
	}
	else if(d.type === "render") {

		temps[d.uid] = d;
	
	}
	else if(d.type === "export") {

		const cvss = Object.values(speks)
		.map(i =>
			i.cvs);

		if(!cvss.length)
			return;

		const {
			width: w,
			height: h
		} = cvss[0];
		
		const cols = Math.ceil(Math.sqrt(cvss.length)), rows = Math.ceil(cvss.length / cols);
		const s = Math.min(
			1,
			4096 / (cols * w),
			4096 / (rows * h)
		);
		const off = new OffscreenCanvas(
			cols * w * s,
			rows * h * s
		);
		const ctx = off.getContext(
			"2d",
			{
				alpha: false
			}
		);

		cvss.forEach((c, i) =>
			ctx.drawImage(
				c,
				(i % cols) * w * s,
				(i / cols | 0) * h * s,
				w * s,
				h * s
			));
		off.convertToBlob()
		.then(b =>
			b.arrayBuffer())
		.then(ab =>
			postMessage(
				{
					type: "export",
					data: ab
				},
				[ab]
			));
	
	}

};

const loop = () => {

	for(const uid in temps) {

		render(
			uid,
			temps[uid]
		);
		delete temps[uid];

	}
	requestAnimationFrame(loop);

};

loop();

const render = (uid, {
	lay, zoom, pan, dpr, dat, drg, log
}) => {

	const inst = speks[uid];

	if(!inst || !lay.w || !lay.h)
		return;

	const {
			ctx, aud, siz, win
		} = inst, {
			x, y, w, h, fw, fh
		} = lay;

	ctx.canvas.width = fw;
	ctx.canvas.height = fh;
	
	drawUI(
		ctx,
		lay,
		dpr,
		dat,
		aud,
		zoom,
		pan,
		log
	);

	if(!aud)
		return;

	const {
			len, chn, spr
		} = aud, fft = FFT(siz), bins = siz >> 1;
	const stepPx = drg ? 4 : 1;
	const step = Math.max(
		1,
		((Math.floor((pan + 1 / zoom) * len) - Math.floor(pan * len)) / w) | 0
	);
	const norm = 20 * Math.log10(1 / siz), range = MAX_DB - MIN_DB;
	const real = new Float32Array(siz), imag = new Float32Array(siz);
	const img = new ImageData(
			w,
			h
		), pix = new Uint32Array(img.data.buffer);
	
	// Pre-calc Freq Mapping
	const rowMap = new Float32Array(h * 2);

	if(log) {

		const maxLog = Math.min(
			spr / 2,
			LOG_MAX
		);
		const logS = Math.log(maxLog / LOG_MIN), f = siz / spr;

		for(let r = 0; r < h; r++) {

			rowMap[r * 2] = Math.max(
				0,
				LOG_MIN * Math.exp((h - r - 1) / h * logS) * f
			);
			rowMap[r * 2 + 1] = Math.min(
				bins - 1,
				LOG_MIN * Math.exp((h - r) / h * logS) * f
			);
		
		}
	
	}
	else {

		const f = bins / h;

		for(let r = 0; r < h; r++) {

			rowMap[r * 2] = (h - r - 1) * f;
			rowMap[r * 2 + 1] = (h - r) * f;

		}
	
	}

	for(let px = 0; px < w; px += stepPx) {

		const off = Math.floor(pan * len) + Math.round((px + (stepPx - 1) / 2) * step) - bins;
		let dc = 0;

		for(let i = 0; i < siz; i++) {

			const v = (off + i >= 0 && off + i < len) ? chn[off + i] : 0;

			real[i] = v;
			dc += v;
		
		}
		dc /= siz;

		for(let i = 0; i < siz; i++) {

			real[i] = (real[i] - dc) * win[i];
			imag[i] = 0;

		}
		calcFFT(
			fft,
			real,
			imag
		);

		for(let r = 0; r < h; r++) {

			const b0 = rowMap[r * 2], b1 = rowMap[r * 2 + 1];
			let peak = 0;

			if(b1 - b0 < 1) { // Interpolate

				const c = (b0 + b1) * 0.5, i = Math.floor(c), wMix = c - i;
				const v1 = (i >= 0 && i < bins) ? real[i] ** 2 + imag[i] ** 2 : 0;
				const v2 = (i + 1 >= 0 && i + 1 < bins) ? real[i + 1] ** 2 + imag[i + 1] ** 2 : 0;

				peak = v1 + wMix * (v2 - v1);
			
			}
			else { // Peak

				const i0 = Math.floor(b0), i1 = Math.ceil(b1);

				for(let b = Math.max(
					0,
					i0
				); b < Math.min(
						bins,
						i1
					); b++)
					peak = Math.max(
						peak,
						real[b] ** 2 + imag[b] ** 2
					);
			
			}

			const val = Math.max(
				0,
				Math.min(
					255,
					(10 * Math.log10(peak + 1e-20) + norm - MIN_DB) / range * 255 | 0
				)
			);
			const col = PAL[val];

			for(let f = px; f < Math.min(
				w,
				px + stepPx
			); f++)
				pix[r * w + f] = col;
		
		}
	
	}
	ctx.putImageData(
		img,
		x,
		y
	);

};

const drawUI = (ctx, {
	x, y, w, h, fw, fh
}, dpr, dat, aud, zoom, pan, log) => {

	const tck = 4 * dpr, fs = Math.max(
		8,
		Math.min(
			12,
			Math.min(
				w,
				h
			) / 25
		)
	) * dpr;
	
	// Back & Frame
	ctx.fillStyle = "#000";
	ctx.fillRect(
		0,
		0,
		fw,
		fh
	);
	ctx.fillStyle = "#757575";
	ctx.strokeStyle = "#757575";
	ctx.strokeRect(
		0,
		0,
		fw,
		fh
	);
	
	// Text & Info
	ctx.fillStyle = "#939393";
	ctx.font = `${fs * 1.2}px system-ui`;
	ctx.textAlign = "left";
	ctx.textBaseline = "middle";
	let nm = dat.nnm;

	if(ctx.measureText(nm).width > fw - x * 2) {

		while(nm.length > 0 && ctx.measureText(nm + "…").width > fw - x * 2)
			nm = nm.slice(
				0,
				-1
			);
		nm += "…";
	
	}

	ctx.fillText(
		nm,
		x,
		y / 3
	);
	ctx.fillStyle = "#646464";
	ctx.font = `${fs * 0.9}px system-ui`;
	ctx.fillText(
		dat.inf,
		x,
		y * 3 / 4
	);

	if(!aud)
		return;

	const {
			spr, len
		} = aud, nyq = spr / 2;
	
	// Frequency Y axis
	ctx.fillStyle = "#434343";
	ctx.textAlign = "right";
	ctx.font = `${fs * 0.8}px system-ui`;
	const drawLbl = (lbl, yp) => {

		if(yp > y + fs && yp < y + h - fs) {

			ctx.fillText(
				lbl,
				x - tck - 4,
				yp
			);
			ctx.fillRect(
				x - tck,
				yp,
				tck,
				1
			);

		}
	
	};

	if(log) {

		const maxLog = Math.min(
			nyq,
			LOG_MAX
		);
		const logS = Math.log(maxLog / LOG_MIN);

		[20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4].forEach(f => {

			if(f <= maxLog)
				drawLbl(
					f >= 1e3 ? (f / 1e3) + "k" : f,
					y + h - (Math.log(f / LOG_MIN) / logS) * h
				);
		
		});

		if(h > fs * 4) {

			ctx.fillText(
				Math.round(maxLog / 1e3) + "k",
				x - tck - 4,
				y
			);
			ctx.fillRect(
				x - tck,
				y - 1,
				tck,
				1
			);
			ctx.fillText(
				"20",
				x - tck - 4,
				y + h
			);
			ctx.fillRect(
				x - tck,
				y + h,
				tck,
				1
			);

		}

		if(y > fs * 1.5)
			ctx.fillText(
				"Hz",
				x - tck - 5,
				y - fs
			);
	
	}
	else {

		const steps = [1e3, 2e3, 5e3, 1e4, 2e4, 5e4], step = steps.find(s =>
			nyq / s <= Math.max(
				2,
				h / (fs * 2.5)
			)) || steps[steps.length - 1];

		for(let f = 0; f <= nyq; f += step)
			drawLbl(
				Math.round(f / 1e3),
				y + h - f / nyq * h
			);

		if(h > fs * 4) {

			ctx.fillText(
				Math.round(nyq / 1e3),
				x - tck - 4,
				y
			);
			ctx.fillRect(
				x - tck,
				y - 1,
				tck,
				1
			);
			ctx.fillText(
				"0",
				x - tck - 4,
				y + h
			);
			ctx.fillRect(
				x - tck,
				y + h,
				tck,
				1
			);

		}

		if(y > fs * 1.5)
			ctx.fillText(
				"kHz",
				x - tck,
				y - fs
			);
	
	}

	// Time X axis
	ctx.fillStyle = "#646464";
	ctx.textAlign = "center";
	ctx.textBaseline = "top";
	const dur = len / spr, vDur = dur / zoom, vSt = pan * dur, steps = [1, 2, 5, 10, 30, 60, 120, 300, 600, 1800];
	const tStep = steps.find(s =>
		vDur / s <= Math.max(
			2,
			w / (fs * 4)
		)) || steps[steps.length - 1];

	for(let t = Math.ceil(vSt / tStep) * tStep; t <= vSt + vDur; t += tStep) {

		const px = x + (t - vSt) / vDur * w;

		if(px >= x && px <= x + w) {

			const m = t / 60 | 0, s = t % 60 | 0;

			ctx.fillText(
				m > 0 ? `${m}:${s.toString()
				.padStart(
					2,
					"0"
				)}` : `${s}s`,
				px,
				y + h + tck + 4
			);
			ctx.fillRect(
				px - 1,
				y + h,
				1,
				tck
			);
		
		}
	
	}

	// dB Legend
	ctx.fillStyle = "#434343";
	const dx = x + w + 3 * dpr, sw = Math.floor(6 * dpr);
	const g32 = new Uint32Array(ctx.createImageData(
		sw,
		h + 1
	).data.buffer);

	for(let py = 0; py <= h; py++) {

		const c = PAL[(1 - py / h) * 255 | 0];

		for(let i = 0; i < sw; i++)
			g32[py * sw + i] = c;

	}
	ctx.putImageData(
		new ImageData(
			new Uint8ClampedArray(g32.buffer),
			sw,
			h + 1
		),
		dx,
		y - 1
	);
	
	if(y > fs * 1.5) {

		ctx.textAlign = "left";
		ctx.textBaseline = "middle";
		ctx.fillText(
			"dB",
			dx + sw + 12,
			y - fs
		);

	}

	const dbSt = [10, 20, 30, 40, 60].find(s =>
		(MAX_DB - MIN_DB) / s <= Math.max(
			2,
			h / (fs * 2)
		)) || 60;

	for(let db = MIN_DB; db <= MAX_DB; db += dbSt) {

		const py = y + h - (db - MIN_DB) / (MAX_DB - MIN_DB) * (h + 1);

		ctx.fillText(
			db,
			dx + sw + 6,
			py
		);
		ctx.fillRect(
			dx - 3 * dpr,
			py,
			6,
			1
		);
	
	}
	ctx.strokeRect(
		x,
		y,
		w,
		h
	);

};