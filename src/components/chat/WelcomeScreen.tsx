import { motion } from 'framer-motion';
import { Zap, Globe, Shield, Rocket } from 'lucide-react';

interface WelcomeScreenProps {
  modelName?: string;
  onSuggestionClick: (suggestion: string) => void;
}

const containerVariants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.1,
      delayChildren: 0.1,
    }
  }
} as const;

const itemVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: { 
    opacity: 1, 
    y: 0,
    transition: {
      duration: 0.6,
      ease: [0.23, 1, 0.32, 1]
    }
  }
} as const;

export default function WelcomeScreen({ onSuggestionClick ,
  modelName = "Flyer"
}: WelcomeScreenProps) {
  return (
    <section 
      className="flex-1 flex items-center justify-center p-4 sm:p-6 md:p-8 min-h-[calc(100dvh-12rem)]"
      aria-label={`Welcome to ${modelName}`}
    >
      <motion.div 
        className="max-w-2xl w-full text-center"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        {/* Hero Section */}
        <motion.header variants={itemVariants} className="mb-8 sm:mb-10">
          {/* Stunning animated logo */}
          <motion.div 
            className="relative inline-flex items-center justify-center w-24 h-24 sm:w-28 sm:h-28 md:w-32 md:h-32 mb-6"
          >
            {/* Multiple glow rings */}
            <motion.div
              className="absolute inset-0 rounded-3xl"
              style={{
                background: 'conic-gradient(from var(--angle), hsl(var(--primary) / 0.3), hsl(200 80% 50% / 0.3), hsl(280 70% 50% / 0.3), hsl(var(--primary) / 0.3))',
              }}
              animate={{
                '--angle': ['0deg', '360deg'],
                scale: [1, 1.1, 1],
              } as any}
              transition={{
                '--angle': { duration: 4, repeat: Infinity, ease: 'linear' },
                scale: { duration: 3, repeat: Infinity, ease: 'easeInOut' },
              }}
            />
            
            <motion.div
              className="absolute inset-2 rounded-2xl bg-gradient-to-br from-primary/30 to-primary/10 blur-xl"
              animate={{
                opacity: [0.5, 0.8, 0.5],
              }}
              transition={{
                duration: 2,
                repeat: Infinity,
                ease: "easeInOut"
              }}
            />
            
            {/* Main icon container */}
            <motion.div 
              className="relative w-full h-full rounded-3xl liquid-icon flex items-center justify-center backdrop-blur-xl overflow-hidden"
              whileHover={{ scale: 1.05, rotate: 5 }}
              transition={{ type: "spring", stiffness: 300 }}
              style={{
                boxShadow: '0 0 60px hsla(172, 66%, 50%, 0.25), inset 0 0 40px hsla(172, 66%, 50%, 0.1)'
              }}
            >
              {/* Inner rotating gradient */}
              <motion.div
                className="absolute inset-0"
                style={{
                  background: 'conic-gradient(from var(--angle), transparent, hsl(var(--primary) / 0.2), transparent)',
                }}
                animate={{ '--angle': ['0deg', '360deg'] } as any}
                transition={{ duration: 3, repeat: Infinity, ease: 'linear' }}
              />
              <img src="/flyer-logo.png" alt="Flyer AI" className="w-full h-full object-cover relative z-10 rounded-2xl" />
            </motion.div>
          </motion.div>
          
          <motion.h1
            className="text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-display font-bold mb-3 sm:mb-4 tracking-tight"
            variants={itemVariants}
          >
            <span className="gradient-text">Flyer</span>
            <span className="text-foreground/40 font-light"> AI</span>
          </motion.h1>

          <motion.p
            className="text-foreground/70 text-base sm:text-lg md:text-xl max-w-md mx-auto leading-relaxed px-2 font-medium"
            variants={itemVariants}
          >
            How can I help you today?
          </motion.p>

          <motion.div
            className="flex items-center justify-center gap-2 mt-3 px-2"
            variants={itemVariants}
          >
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs sm:text-sm text-muted-foreground/80">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              Powered by <span className="text-primary/90 font-semibold">{modelName}</span>
            </span>
          </motion.div>
        </motion.header>

        {/* Feature badges - Compact and elegant */}
        <motion.div 
          className="flex flex-wrap justify-center gap-2 sm:gap-3 mb-8 px-2"
          variants={itemVariants}
        >
          {[
            { icon: Zap, label: "Lightning Fast", color: "text-amber-400", bg: "bg-amber-500/10", border: "border-amber-500/20" },
            { icon: Globe, label: "Real-time Search", color: "text-emerald-400", bg: "bg-emerald-500/10", border: "border-emerald-500/20" },
            { icon: Shield, label: "Secure & Private", color: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/20" },
            { icon: Rocket, label: "Always Learning", color: "text-cyan-400", bg: "bg-cyan-500/10", border: "border-cyan-500/20" },
          ].map((badge, index) => (
            <motion.div
              key={badge.label}
              className={`flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 rounded-full ${badge.bg} border ${badge.border} backdrop-blur-sm shadow-sm liquid-surface`}
              initial={{ opacity: 0, scale: 0.8 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ delay: 0.5 + index * 0.05 }}
              whileHover={{ scale: 1.05, y: -2, boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
            >
              <badge.icon className={`w-3.5 h-3.5 sm:w-4 sm:h-4 ${badge.color}`} />
              <span className="text-xs sm:text-sm text-foreground/80 font-medium">{badge.label}</span>
            </motion.div>
          ))}
        </motion.div>

        

        {/* Interactive Prompt Suggestions */}
        <motion.div
          className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8 px-2 text-left"
          variants={itemVariants}
        >
          {[
            { emoji: "🎨", title: "Generate an Image", prompt: "Generate a futuristic cyberpunk city in neon rain with photorealistic 8k detail", tag: "Image AI" },
            { emoji: "💻", title: "Write & Debug Code", prompt: "Write a high-performance Python script to analyze data with clean docstrings and error handling", tag: "Code Specialist" },
            { emoji: "🌐", title: "Search Live News", prompt: "What are the latest AI news developments and breakthroughs today?", tag: "Real-time Web" },
            { emoji: "🧠", title: "Deep Concepts", prompt: "Explain quantum computing and qubit entanglement simply with a real-world analogy", tag: "Reasoning" },
          ].map((item, idx) => (
            <motion.button
              key={item.title}
              onClick={() => onSuggestionClick(item.prompt)}
              className="group flex flex-col justify-between p-4 rounded-2xl border border-border/40 bg-secondary/20 hover:bg-secondary/50 hover:border-primary/40 transition-all duration-300 backdrop-blur-sm text-left relative overflow-hidden shadow-sm"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.4 + idx * 0.08 }}
              whileHover={{ scale: 1.02, y: -2 }}
              whileTap={{ scale: 0.98 }}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-2xl">{item.emoji}</span>
                <span className="text-[10px] font-bold uppercase tracking-wider text-primary/80 bg-primary/10 border border-primary/20 rounded-full px-2 py-0.5">
                  {item.tag}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-foreground/90 group-hover:text-primary transition-colors mb-1">
                {item.title}
              </h3>
              <p className="text-xs text-muted-foreground/60 line-clamp-2 leading-relaxed">
                "{item.prompt}"
              </p>
            </motion.button>
          ))}
        </motion.div>

        {/* Call to action - Focus on input */}
        <motion.div
          className="mt-6"
          variants={itemVariants}
        >
          <motion.div
            className="inline-flex items-center gap-2 px-4 py-2 rounded-full border border-primary/20 backdrop-blur-sm liquid-surface"
            animate={{
              boxShadow: ['0 0 20px hsla(172, 66%, 50%, 0.05)', '0 0 40px hsla(172, 66%, 50%, 0.15)', '0 0 20px hsla(172, 66%, 50%, 0.05)'],
            }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            <motion.div
              className="w-2 h-2 rounded-full bg-primary"
              animate={{ scale: [1, 1.3, 1], opacity: [0.7, 1, 0.7] }}
              transition={{ duration: 1.5, repeat: Infinity }}
            />
            <span className="text-xs sm:text-sm text-primary font-semibold">Multi-model AI · Online & Ready</span>
          </motion.div>
        </motion.div>
      </motion.div>
    </section>
  );
}
