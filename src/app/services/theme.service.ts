import { Injectable, signal, effect } from '@angular/core';

export type ColorScheme = 'light' | 'dark' | 'system';
export type NavigationPosition = 'horizontal' | 'vertical' | 'collapsible';
export type LayoutStyle = 'box' | 'full';
export type Direction = 'ltr' | 'rtl';
export type NavbarType = 'sticky' | 'floating' | 'static';

export interface ThemeConfig {
  colorScheme: ColorScheme;
  navigationPosition: NavigationPosition;
  layoutStyle: LayoutStyle;
  direction: Direction;
  navbarType: NavbarType;
  semiDark: boolean;
}

const defaultThemeConfig: ThemeConfig = {
  colorScheme: 'light',
  navigationPosition: 'vertical',
  layoutStyle: 'full',
  direction: 'ltr',
  navbarType: 'floating',
  semiDark: false
};

@Injectable({
  providedIn: 'root'
})
export class ThemeService {
  private readonly storageKey = 'clarix-theme-config';
  
  // Theme configuration signals
  public colorScheme = signal<ColorScheme>('light');
  public navigationPosition = signal<NavigationPosition>('vertical');
  public layoutStyle = signal<LayoutStyle>('full');
  public direction = signal<Direction>('ltr');
  public navbarType = signal<NavbarType>('floating');
  public semiDark = signal<boolean>(false);
  
  // UI state signals
  public sidebarCollapsed = signal<boolean>(false);
  public sidebarOpen = signal<boolean>(false);
  public themeCustomizerOpen = signal<boolean>(false);
  
  constructor() {
    this.loadThemeConfig();
    this.setupThemeEffects();
    // Initialize sidebar state based on screen size
    this.initializeSidebarState();
  }

  private initializeSidebarState(): void {
    if (typeof window !== 'undefined') {
      if (window.innerWidth <= 768) {
        this.sidebarOpen.set(false); // Hidden by default on mobile
        this.sidebarCollapsed.set(false);
      } else {
        this.sidebarOpen.set(false);
        this.sidebarCollapsed.set(true); // Collapsed by default on desktop
      }
    }
  }

  private loadThemeConfig(): void {
    try {
      const saved = localStorage.getItem(this.storageKey);
      if (saved) {
        const config: ThemeConfig = { ...defaultThemeConfig, ...JSON.parse(saved) };
        this.updateThemeConfig(config);
      } else {
        this.updateThemeConfig(defaultThemeConfig);
      }
    } catch (error) {
      console.warn('Failed to load theme config, using defaults');
      this.updateThemeConfig(defaultThemeConfig);
    }
  }

  private updateThemeConfig(config: ThemeConfig): void {
    this.colorScheme.set(config.colorScheme);
    this.navigationPosition.set(config.navigationPosition);
    this.layoutStyle.set(config.layoutStyle);
    this.direction.set(config.direction);
    this.navbarType.set(config.navbarType);
    this.semiDark.set(config.semiDark);
  }

  private setupThemeEffects(): void {
    // Auto-save theme config when any setting changes
    effect(() => {
      const config: ThemeConfig = {
        colorScheme: this.colorScheme(),
        navigationPosition: this.navigationPosition(),
        layoutStyle: this.layoutStyle(),
        direction: this.direction(),
        navbarType: this.navbarType(),
        semiDark: this.semiDark()
      };
      
      localStorage.setItem(this.storageKey, JSON.stringify(config));
      this.applyThemeToDOM(config);
    });

    // Handle system color scheme changes
    effect(() => {
      if (this.colorScheme() === 'system') {
        this.handleSystemColorSchemeChange();
      }
    });
  }

  private applyThemeToDOM(config: ThemeConfig): void {
    const html = document.documentElement;
    
    // Remove all theme classes
    html.classList.remove('dark', 'light', 'horizontal', 'vertical', 'collapsible', 'box', 'full', 'rtl', 'ltr', 'sticky', 'floating', 'static', 'semi-dark');
    
    // Apply color scheme
    const actualColorScheme = config.colorScheme === 'system' 
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : config.colorScheme;
    html.classList.add(actualColorScheme);
    
    // Apply other theme classes
    html.classList.add(config.navigationPosition);
    html.classList.add(config.layoutStyle);
    html.classList.add(config.direction);
    html.classList.add(config.navbarType);
    
    if (config.semiDark) {
      html.classList.add('semi-dark');
    }
    
    // Set direction attribute
    html.setAttribute('dir', config.direction);
  }

  private handleSystemColorSchemeChange(): void {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => this.applyThemeToDOM(this.getCurrentConfig());
    
    mediaQuery.addEventListener('change', handleChange);
    handleChange(); // Apply initial system theme
  }

  private getCurrentConfig(): ThemeConfig {
    return {
      colorScheme: this.colorScheme(),
      navigationPosition: this.navigationPosition(),
      layoutStyle: this.layoutStyle(),
      direction: this.direction(),
      navbarType: this.navbarType(),
      semiDark: this.semiDark()
    };
  }

  // Public methods for updating theme
  setColorScheme(scheme: ColorScheme): void {
    this.colorScheme.set(scheme);
  }

  setNavigationPosition(position: NavigationPosition): void {
    this.navigationPosition.set(position);
  }

  setLayoutStyle(style: LayoutStyle): void {
    this.layoutStyle.set(style);
  }

  setDirection(direction: Direction): void {
    this.direction.set(direction);
  }

  setNavbarType(type: NavbarType): void {
    this.navbarType.set(type);
  }

  setSemiDark(enabled: boolean): void {
    this.semiDark.set(enabled);
  }

  toggleSidebar(): void {
    // On mobile, toggle the sidebarOpen state
    if (window.innerWidth <= 768) {
      this.sidebarOpen.set(!this.sidebarOpen());
    } else {
      // On desktop, toggle collapsed state
      this.sidebarCollapsed.set(!this.sidebarCollapsed());
    }
  }

  closeSidebar(): void {
    this.sidebarOpen.set(false);
  }

  toggleThemeCustomizer(): void {
    this.themeCustomizerOpen.set(!this.themeCustomizerOpen());
  }

  resetThemeToDefaults(): void {
    this.updateThemeConfig(defaultThemeConfig);
  }
}