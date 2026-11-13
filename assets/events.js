/* ==========================================================================
   Events — countdown timer and the "Moments that sparkle" card slider.
   ========================================================================== */

class EventCountdown extends HTMLElement {
  connectedCallback() {
    this.target = Date.parse(this.dataset.target);
    this.timer = this.querySelector('[data-countdown-timer]');
    this.expired = this.querySelector('[data-countdown-expired]');

    if (Number.isNaN(this.target)) {
      // A malformed date should not leave a frozen "00" clock on the page.
      this.hideTimer();
      return;
    }

    this.units = {
      days: this.querySelector('[data-unit="days"]'),
      hours: this.querySelector('[data-unit="hours"]'),
      minutes: this.querySelector('[data-unit="minutes"]'),
      seconds: this.querySelector('[data-unit="seconds"]'),
    };

    this.tick();
    this.interval = setInterval(() => this.tick(), 1000);
  }

  disconnectedCallback() {
    clearInterval(this.interval);
  }

  tick() {
    const remaining = this.target - Date.now();

    if (remaining <= 0) {
      clearInterval(this.interval);
      this.hideTimer();
      if (this.expired) this.expired.hidden = false;
      return;
    }

    const totalSeconds = Math.floor(remaining / 1000);
    this.render('days', Math.floor(totalSeconds / 86400));
    this.render('hours', Math.floor(totalSeconds / 3600) % 24);
    this.render('minutes', Math.floor(totalSeconds / 60) % 60);
    this.render('seconds', totalSeconds % 60);
  }

  render(unit, value) {
    const element = this.units[unit];
    if (!element) return;
    const padded = String(value).padStart(2, '0');
    if (element.textContent !== padded) element.textContent = padded;
  }

  hideTimer() {
    if (this.timer) this.timer.hidden = true;
  }
}

if (!customElements.get('event-countdown')) {
  customElements.define('event-countdown', EventCountdown);
}

class MomentsSlider extends HTMLElement {
  connectedCallback() {
    this.viewport = this.querySelector('[data-moments-viewport]');
    if (!this.viewport) return;

    this.slides = Array.from(this.querySelectorAll('[data-moments-slide]'));
    this.prevButton = this.querySelector('[name="previous"]');
    this.nextButton = this.querySelector('[name="next"]');
    this.dotsContainer = this.querySelector('[data-moments-dots]');
    this.autoplayDelay = parseInt(this.dataset.autoplay, 10) * 1000;
    this.currentPage = 0;

    this.lightbox = this.querySelector('[data-moments-lightbox]');
    this.lightboxStage = this.querySelector('[data-moments-lightbox-stage]');
    if (this.lightbox) {
      // A `position: fixed` element only covers the real viewport if none of
      // its ancestors set a transform/filter/perspective (each of those makes
      // itself the containing block instead). Slider/card markup is exactly
      // the kind of place that ends up with one, so the lightbox is moved to
      // be a direct child of <body> rather than trusting it stays escaped.
      document.body.appendChild(this.lightbox);

      this.lightbox.querySelectorAll('[data-moments-lightbox-dismiss]').forEach((dismisser) => {
        dismisser.addEventListener('click', () => this.closeLightbox());
      });
      this.onKeydown = (event) => {
        if (event.key === 'Escape') this.closeLightbox();
      };
      document.addEventListener('keydown', this.onKeydown);
    }

    this.onScroll = this.debounce(() => this.update(), 80);
    this.viewport.addEventListener('scroll', this.onScroll, { passive: true });

    if (this.prevButton) this.prevButton.addEventListener('click', () => this.step(-1));
    if (this.nextButton) this.nextButton.addEventListener('click', () => this.step(1));

    this.addEventListener('click', (event) => {
      const pauseButton = event.target.closest('[data-moments-pause]');
      if (pauseButton) {
        const video = pauseButton.closest('deferred-media').querySelector('video');
        if (video) video.pause();
        return;
      }

      const poster = event.target.closest('[data-moments-play]');
      if (!poster) return;

      const media = poster.closest('deferred-media');
      this.stopAutoplay();

      // deferred-media injects the player from its own listener on this same
      // button, which runs before this delegated one, so it is already there.
      const player = media.querySelector('video, iframe');
      if (!player) return;

      // pauseAllMedia() only pauses the other reels; without this they keep
      // their loaded flag, which hides their cover and play button and leaves
      // a frozen frame that cannot be replayed.
      this.querySelectorAll('deferred-media[loaded]').forEach((other) => {
        if (other !== media) this.resetMedia(other);
      });

      this.openLightbox(media, player);
    });

    // A reel scrolled off the viewport should not keep playing out of sight.
    this.visibilityObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) return;
          const media = entry.target.querySelector('deferred-media[loaded]');
          if (media) this.resetMedia(media);
        });
      },
      { root: this.viewport, threshold: 0.4 }
    );
    this.slides.forEach((slide) => this.visibilityObserver.observe(slide));

    this.resizeObserver = new ResizeObserver(() => this.measure());
    this.resizeObserver.observe(this.viewport);

    this.measure();
    this.startAutoplay();
  }

  disconnectedCallback() {
    this.stopAutoplay();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    if (this.visibilityObserver) this.visibilityObserver.disconnect();
    this.viewport?.removeEventListener('scroll', this.onScroll);
    if (this.onKeydown) document.removeEventListener('keydown', this.onKeydown);
    // Was moved to <body> in connectedCallback — without this, re-rendering
    // the section (e.g. every edit in the theme editor) would leave a stale,
    // orphaned lightbox behind each time instead of replacing it.
    this.lightbox?.remove();
  }

  /* Wire a player once. deferred-media may already have injected and started
     it before this runs, so this must not assume it is being called first. */
  bindPlayer(media, video) {
    if (video.dataset.momentsBound) return;
    video.dataset.momentsBound = 'true';
    video.playsInline = true;
    video.muted = false;

    // Track the player's own events rather than assuming why it stopped, so
    // the buttons stay right even when pauseAllMedia() halts it from outside.
    video.addEventListener('play', () => media.removeAttribute('data-paused'));
    video.addEventListener('pause', () => {
      if (!video.ended) media.setAttribute('data-paused', '');
    });

    // Reels play once, so hand the card back when one reaches the end.
    video.addEventListener('ended', () => this.resetMedia(media), { once: true });
  }

  /* Reels play with sound, which browsers only permit off the back of a real
     user gesture. If the policy blocks it anyway, fall back to muted so the
     reel still plays rather than silently refusing to start. */
  playWithSound(video) {
    video.muted = false;
    const started = video.play();
    if (!started || typeof started.catch !== 'function') return;
    started.catch(() => {
      video.muted = true;
      video.play();
    });
  }

  /* A card is far too small to actually watch a reel in, so the clicked
     player is relocated into the shared lightbox instead of staying put. The
     card is reset to its poster immediately — the video no longer lives
     inside it, so there is nothing left there to show as "playing". */
  openLightbox(media, player) {
    if (!this.lightbox) return;

    media.removeAttribute('loaded');
    media.removeAttribute('data-paused');

    this.lightboxStage.appendChild(player);
    this.lightbox.hidden = false;
    document.body.classList.add('moments-lightbox-open');

    if (player.tagName === 'VIDEO') {
      this.bindPlayer(media, player);
      player.addEventListener('ended', () => this.closeLightbox(), { once: true });
      if (player.paused) this.playWithSound(player);
    }
  }

  /* Drops the player entirely rather than pausing and keeping it around —
     reels play once, so the next click should re-clone a fresh one from the
     untouched <template> exactly like the inline flow always has. */
  closeLightbox() {
    if (!this.lightbox || this.lightbox.hidden) return;

    const player = this.lightboxStage.querySelector('video, iframe');
    if (player) {
      if (typeof player.pause === 'function') player.pause();
      player.remove();
    }

    this.lightbox.hidden = true;
    document.body.classList.remove('moments-lightbox-open');
  }

  /* Return a card to its cover image and play button. Dropping the injected
     player is what clears deferred-media's loaded flag, and it lets the next
     click re-clone a fresh player from the untouched <template>. */
  resetMedia(media) {
    if (!media) return;
    media.querySelectorAll('video, iframe').forEach((player) => {
      if (typeof player.pause === 'function') player.pause();
      player.remove();
    });
    media.removeAttribute('loaded');
    media.removeAttribute('data-paused');
  }

  /* Measure how many whole slides fit, then rebuild the dots to match. */
  measure() {
    const visible = this.slides.filter((slide) => slide.clientWidth > 0);
    if (visible.length < 1) return;

    this.visibleSlides = visible;
    this.slideStep =
      visible.length > 1 ? visible[1].offsetLeft - visible[0].offsetLeft : visible[0].clientWidth;
    this.perPage = Math.max(1, Math.round(this.viewport.clientWidth / this.slideStep));
    this.totalPages = Math.max(1, visible.length - this.perPage + 1);
    // Every slide already fits at this width, so the arrows have nothing to do.
    // CSS acts on this only at desktop; narrower views always keep them.
    this.toggleAttribute('data-no-scroll', this.totalPages <= 1);
    // Browsers report scrollLeft as negative in right-to-left writing modes.
    this.isRtl = getComputedStyle(this.viewport).direction === 'rtl';

    this.buildDots();
    this.update();
  }

  buildDots() {
    if (!this.dotsContainer) return;

    // Only one page worth of slides: controls would be noise.
    if (this.totalPages <= 1) {
      this.dotsContainer.innerHTML = '';
      this.dotsContainer.hidden = true;
      return;
    }

    this.dotsContainer.hidden = false;
    if (this.dotsContainer.children.length === this.totalPages) return;

    this.dotsContainer.innerHTML = '';
    for (let index = 0; index < this.totalPages; index += 1) {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = 'moments__dot';
      dot.setAttribute('aria-label', `${this.dotsContainer.dataset.slideLabel || 'Slide'} ${index + 1}`);
      dot.addEventListener('click', () => {
        this.stopAutoplay();
        this.goTo(index);
      });
      this.dotsContainer.appendChild(dot);
    }
  }

  scrollStart() {
    return Math.abs(this.viewport.scrollLeft);
  }

  update() {
    if (!this.slideStep) return;

    this.currentPage = Math.min(
      this.totalPages - 1,
      Math.max(0, Math.round(this.scrollStart() / this.slideStep))
    );

    if (this.prevButton) this.prevButton.disabled = this.currentPage === 0;
    if (this.nextButton) this.nextButton.disabled = this.currentPage >= this.totalPages - 1;

    if (this.dotsContainer) {
      Array.from(this.dotsContainer.children).forEach((dot, index) => {
        dot.setAttribute('aria-current', index === this.currentPage ? 'true' : 'false');
      });
    }
  }

  goTo(page) {
    const target = page * this.slideStep;
    this.viewport.scrollTo({
      left: this.isRtl ? -target : target,
      behavior: 'smooth',
    });
  }

  step(direction) {
    this.stopAutoplay();
    let next = this.currentPage + direction;
    if (next < 0) next = 0;
    if (next > this.totalPages - 1) next = this.totalPages - 1;
    this.goTo(next);
  }

  startAutoplay() {
    if (!this.autoplayDelay || this.autoplayDelay < 1000) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    this.autoplayTimer = setInterval(() => {
      if (document.hidden || this.matches(':hover') || this.contains(document.activeElement)) return;
      const next = this.currentPage >= this.totalPages - 1 ? 0 : this.currentPage + 1;
      this.goTo(next);
    }, this.autoplayDelay);
  }

  stopAutoplay() {
    clearInterval(this.autoplayTimer);
    this.autoplayTimer = null;
  }

  debounce(fn, wait) {
    let timeout;
    return (...args) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => fn.apply(this, args), wait);
    };
  }
}

if (!customElements.get('moments-slider')) {
  customElements.define('moments-slider', MomentsSlider);
}

class EditorialGallery extends HTMLElement {
  connectedCallback() {
    this.items = Array.from(this.querySelectorAll('[data-gallery-item]'));
    if (this.items.length === 0) return;

    this.lightbox = this.querySelector('[data-gallery-lightbox]');
    if (!this.lightbox) return;

    this.gridWrap = this.lightbox.querySelector('[data-gallery-lightbox-grid-wrap]');
    this.grid = this.lightbox.querySelector('[data-gallery-lightbox-grid]');
    this.gridTitle = this.lightbox.querySelector('[data-gallery-lightbox-grid-title]');
    this.gridCount = this.lightbox.querySelector('[data-gallery-lightbox-grid-count]');
    this.stage = this.lightbox.querySelector('[data-gallery-lightbox-stage]');
    this.image = this.lightbox.querySelector('[data-gallery-lightbox-image]');
    this.prevButton = this.lightbox.querySelector('[data-gallery-lightbox-prev]');
    this.nextButton = this.lightbox.querySelector('[data-gallery-lightbox-next]');
    this.counter = this.lightbox.querySelector('[data-gallery-lightbox-counter]');
    this.backButton = this.lightbox.querySelector('[data-gallery-lightbox-back]');
    this.images = [];
    this.currentIndex = 0;

    // Same reasoning as the Moments lightbox: position: fixed only ever
    // covers the real viewport when nothing between it and <body> sets a
    // transform/filter/perspective, so it's moved out from under the grid
    // rather than trusting the surrounding markup never grows one of those.
    document.body.appendChild(this.lightbox);

    this.items.forEach((item, index) => {
      item.addEventListener('click', () => this.openShootGrid(index));
    });

    this.lightbox.querySelectorAll('[data-gallery-lightbox-dismiss]').forEach((dismisser) => {
      dismisser.addEventListener('click', () => this.close());
    });

    if (this.prevButton) this.prevButton.addEventListener('click', () => this.step(-1));
    if (this.nextButton) this.nextButton.addEventListener('click', () => this.step(1));
    if (this.backButton) this.backButton.addEventListener('click', () => this.backToGrid());

    this.onKeydown = (event) => {
      if (this.lightbox.hidden) return;
      if (event.key === 'Escape') this.close();
      if (this.stage.hidden) return;
      if (event.key === 'ArrowLeft') this.step(-1);
      if (event.key === 'ArrowRight') this.step(1);
    };
    document.addEventListener('keydown', this.onKeydown);
  }

  disconnectedCallback() {
    if (this.onKeydown) document.removeEventListener('keydown', this.onKeydown);
    // Was moved to <body> in connectedCallback — without this, re-rendering
    // the section (e.g. every edit in the theme editor) would leave a stale,
    // orphaned lightbox behind each time instead of replacing it.
    this.lightbox?.remove();
  }

  /* Step 2: a grid of this shoot's own thumbnails. Small, lazy-loaded images
     open fast — the previous version jumped straight to a full-size (2200px)
     photo on first click, which is what actually made it feel slow. */
  openShootGrid(itemIndex) {
    const script = this.items[itemIndex].querySelector('script[data-gallery-images]');
    if (!script) return;

    try {
      this.images = JSON.parse(script.textContent);
    } catch (error) {
      this.images = [];
    }
    if (this.images.length === 0) return;

    this.grid.innerHTML = '';
    this.images.forEach((photo, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'gallery-lightbox__grid-item';

      const img = document.createElement('img');
      img.src = photo.src.replace('width=2200', 'width=400');
      img.alt = '';
      img.loading = 'lazy';
      button.appendChild(img);

      button.addEventListener('click', () => this.openImage(index));
      this.grid.appendChild(button);
    });

    if (this.gridTitle) this.gridTitle.textContent = this.images[0].alt || '';
    if (this.gridCount) {
      this.gridCount.textContent = `${this.images.length} photo${this.images.length === 1 ? '' : 's'}`;
    }

    this.showGridView();
    this.lightbox.hidden = false;
    document.body.classList.add('gallery-lightbox-open');
  }

  /* Step 3: the single photo, full screen, with prev/next through the same
     shoot. */
  openImage(index) {
    this.currentIndex = index;
    this.render();
    this.showImageView();
  }

  backToGrid() {
    this.showGridView();
  }

  showGridView() {
    this.gridWrap.hidden = false;
    this.stage.hidden = true;
    if (this.prevButton) this.prevButton.hidden = true;
    if (this.nextButton) this.nextButton.hidden = true;
    if (this.counter) this.counter.hidden = true;
    if (this.backButton) this.backButton.hidden = true;
  }

  showImageView() {
    this.gridWrap.hidden = true;
    this.stage.hidden = false;
    if (this.backButton) this.backButton.hidden = false;
  }

  close() {
    if (!this.lightbox || this.lightbox.hidden) return;
    this.lightbox.hidden = true;
    this.image.removeAttribute('src');
    document.body.classList.remove('gallery-lightbox-open');
  }

  step(direction) {
    if (this.images.length < 2) return;
    this.currentIndex = (this.currentIndex + direction + this.images.length) % this.images.length;
    this.render();
  }

  render() {
    const current = this.images[this.currentIndex];
    if (!current) return;

    this.image.src = current.src;
    this.image.alt = current.alt || '';

    const hasMultiple = this.images.length > 1;
    if (this.prevButton) this.prevButton.hidden = !hasMultiple;
    if (this.nextButton) this.nextButton.hidden = !hasMultiple;
    if (this.counter) {
      this.counter.hidden = false;
      this.counter.textContent = `${this.currentIndex + 1} / ${this.images.length}`;
    }
  }
}

if (!customElements.get('editorial-gallery')) {
  customElements.define('editorial-gallery', EditorialGallery);
}
