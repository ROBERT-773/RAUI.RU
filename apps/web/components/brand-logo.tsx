import Image from 'next/image';
import styles from './brand-logo.module.css';

export default function BrandLogo() {
  return (
    <span className={styles.brand}>
      <span className={styles.wordmark}>
        <Image src="/raui-logo.png" alt="РАУИ" width={116} height={49} />
      </span>
      <span className={styles.caption}>Портал недвижимости</span>
    </span>
  );
}
