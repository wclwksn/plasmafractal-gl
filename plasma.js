/*
2D fractal noise image generation and animation. Copyright (c) 2019 zett42.
https://github.com/zett42/PlasmaFractal2

MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. 
*/
//-----------------------------------------------------------------------------------------------------------------------
// Dependencies:
//   external/perlin.js
//   external/mersennetwister/MersenneTwister.js
//   z42easing.js	
//   z42color.js
//   z42FractalNoise.js
//
// NOTE: This can't be a module because it is included by a web worker, which still have limited module support.

//===================================================================================================================
// This is the class for generating and animating a plasma. 

class z42Plasma {
	constructor( params ){
	
		this._options = params.options;

		// Not an option yet, as it is currently bugged for uneven numbers
		this._paletteColorCount = 2;
		
		this._width  = null;
		this._height = null;
		this._plasmaPixels = null;
		
		// Palette size must be big enough to allow for multiple smooth gradients. 
		// 256 entries per color are way too little, because ease function "compress" gradients. In the result, gradients 
		// wouldn't be smooth! For good results the minimum is 1024 entries.
		this._startPalette      = new Uint32Array( new ArrayBuffer( this._paletteColorCount * 2048 * Uint32Array.BYTES_PER_ELEMENT ) );
		this._nextPalette       = new Uint32Array( new ArrayBuffer( this._startPalette.length * Uint32Array.BYTES_PER_ELEMENT ) );
		this._transitionPalette = new Uint32Array( new ArrayBuffer( this._startPalette.length * Uint32Array.BYTES_PER_ELEMENT ) );
		this._currentPalette    = new Uint32Array( new ArrayBuffer( this._startPalette.length * Uint32Array.BYTES_PER_ELEMENT ) );
		this._grayScalePalette  = new Uint32Array( new ArrayBuffer( this._startPalette.length * Uint32Array.BYTES_PER_ELEMENT ) );
		this._paletteCurrentFirstHue = 0;
		
		this._isPaletteTransition = false;     // Palette currently transitioning to next palette?

		this._startTime = performance.now();
		this._paletteStartTime = this._startTime;  // Start time of current phase (constant or transition).

		this._colorRnd = new MersenneTwister( Math.trunc( params.colorSeed * 0xFFFFFFFF ) );

		// Generate initial palette.
		this._generatePalette( this._startPalette, this._colorRnd.random() * 360 ); 
		z42color.makePaletteGradientRGBA( this._grayScalePalette, 0, this._grayScalePalette.length, {r:0,g:0,b:0,a:1.0}, {r:255,g:255,b:255,a:1.0}, z42easing.linear );
	}

	//===================================================================================================================
	// Public methods

	//-------------------------------------------------------------------------------------------------------------------
	// Get / set noise options.

	get noiseOptions()
	{
		return this._options.noise;
	}

	set noiseOptions( opt )
	{
		this._options.noise = opt;
		this.generateNoiseImage();
	}

	//-------------------------------------------------------------------------------------------------------------------
	// Get / set palette options.

	get paletteOptions()
	{
		return this._options.palette;
	}

	set paletteOptions( opt )
	{
		this._options.palette = opt;

		// (Re-)generate the palette without changing the current hue.
		this._generatePalette( this._startPalette, this._paletteCurrentFirstHue );
		
		// We reset the transition animation for simplicity.
		this._isPaletteTransition = false;
		this._paletteStartTime = performance.now();		
	}

	//-------------------------------------------------------------------------------------------------------------------
	// Get / set animation options.

	get paletteAnimOptions()
	{
		return this._options.paletteAnim;
	}

	set paletteAnimOptions( opt )
	{
		if( opt.transitionDelay != this._options.paletteAnim.transitionDelay ||
		    opt.transitionDuration != this._options.paletteAnim.transitionDuration )
		{
			// reset plaette transition animation to avoid some issues
			this._isPaletteTransition = false;  
			this._paletteStartTime = performance.now();
		}
		
		this._options.paletteAnim = opt;
		// Values will be used when drawing next animation frame.
	}

	//-------------------------------------------------------------------------------------------------------------------
	// Resize the image buffers to the given size and recreate fractal noise image (grayscale).

	resize( width, height )
	{
		this._width  = width;
		this._height = height;
		
		this._plasmaPixels = new Uint16Array( new ArrayBuffer( this._width * this._height * Uint16Array.BYTES_PER_ELEMENT ) );

		this.generateNoiseImage();
	}

	//-------------------------------------------------------------------------------------------------------------------
	// Draw animation frame in given 32-bit RGBA image buffer.

	drawAnimationFrame( targetPixels ) 
	{
		if( this._options.palette.isGrayScale )
		{
			z42color.drawImageUint16WithPalette( targetPixels, this._plasmaPixels, this._grayScalePalette );		
		}
		else
		{
			this._animatePalette();
	
			z42color.drawImageUint16WithPalette( targetPixels, this._plasmaPixels, this._currentPalette );
		}
	}	
	
	//-------------------------------------------------------------------------------------------------------------------
	// (Re-)generate the underlying 16-bit grayscale fractal noise image (typically after call to noise.seed()).
	
	generateNoiseImage()
	{
		const fracStartTime = performance.now();

		z42fractal.generateFractalNoiseImageUint16( this._plasmaPixels, this._width, this._height, this._currentPalette.length, this._options.noise ); 

		//console.debug( "Fractal generation took %d ms", performance.now() - fracStartTime );
	}	

	//===================================================================================================================
	// Private methods
	
	//-------------------------------------------------------------------------------------------------------------------
	// Rotate and cross-fade the palette.

	_animatePalette()
	{
		const curTime         = performance.now();
		const totalDuration   = curTime - this._startTime;
		const paletteDuration = curTime - this._paletteStartTime;		
		const paletteOffset   = totalDuration / this._options.paletteAnim.rotaDuration * this._startPalette.length;
							  //+ this._startPalette.length / this._paletteColorCount / 2;
	
		let paletteToRotate = null;
	
		if( this._isPaletteTransition )
		{
			if( paletteDuration <= this._options.paletteAnim.transitionDuration )
			{
				// Still in transition phase.
				const alpha = paletteDuration / this._options.paletteAnim.transitionDuration;
				z42color.blendPalette( this._startPalette, this._nextPalette, this._transitionPalette, alpha );

				paletteToRotate = this._transitionPalette;
			}
			else
			{
				// Transition phase finished. Start the constant phase.
				this._isPaletteTransition = false;
				this._paletteStartTime = curTime;
				
				// swap this._startPalette, this._nextPalette
				[ this._startPalette, this._nextPalette ] = [ this._nextPalette, this._startPalette ];

				paletteToRotate = this._startPalette;
			}			
		}
		else
		{
			if( paletteDuration > this._options.paletteAnim.transitionDelay )
			{
				// Constant phase finished. Start the transition phase.
				this._isPaletteTransition = true;
				this._paletteStartTime = curTime;

				this._generatePalette( this._nextPalette, this._colorRnd.random() * 360 ); 
			}
			// else still in constant phase. Nothing to do.

			paletteToRotate = this._startPalette;
		}

		z42color.rotatePalette( paletteToRotate, this._currentPalette, paletteOffset );
	}
		
	//-------------------------------------------------------------------------------------------------------------------
	// Generate a beautiful loopable palette with random start color. Subsequent colors will be generated by adding
	// golden ratio to hue value, which creates nices contrasts.

	_generatePalette( palette, firstHue )
	{
		this._paletteCurrentFirstHue = firstHue;
	
		let colorHsv = { 
			h : firstHue,   
			s : this._options.palette.saturation, 
			v : this._options.palette.brightness,
			a : 1  // alpha
		};

		const bgToFgFunction = z42easing[ this._options.palette.easeFunctionBgToFg ];
		const fgToBgFunction = z42easing[ this._options.palette.easeFunctionFgToBg ];
		
		let palIndex = 0;
		const palRange = palette.length / this._paletteColorCount / 2;
		
		for( let i = 0; i < this._paletteColorCount; ++i )
		{
			const colorRGBA = z42color.nextGoldenRatioColorRGBA( colorHsv ); 
		
			palIndex = z42color.makePaletteGradientRGBA( palette, palIndex, palRange, this._options.palette.bgColor, colorRGBA, bgToFgFunction );
			palIndex = z42color.makePaletteGradientRGBA( palette, palIndex, palRange, colorRGBA, this._options.palette.bgColor, fgToBgFunction );			
		}
	}	
}