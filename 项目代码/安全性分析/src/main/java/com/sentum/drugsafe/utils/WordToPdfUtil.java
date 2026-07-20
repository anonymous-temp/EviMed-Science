package com.sentum.drugsafe.utils;

import org.jodconverter.core.office.OfficeException;
import org.jodconverter.local.LocalConverter;
import org.jodconverter.local.office.LocalOfficeManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;

/**
 * Converts Word documents to PDF using LibreOffice through JODConverter.
 * Replaces the previous Aspose-based implementation; the Aspose-specific
 * Spring component/font wiring was dropped together with it.
 */
public final class WordToPdfUtil {

    private static final Logger log = LoggerFactory.getLogger(WordToPdfUtil.class);

    /** Environment variable pointing to the LibreOffice installation directory. */
    private static final String OFFICE_HOME_ENV = "EVIMED_OFFICE_HOME";

    /** Default LibreOffice location on macOS. */
    private static final String DEFAULT_OFFICE_HOME = "/Applications/LibreOffice.app/Contents";

    private static volatile LocalOfficeManager officeManager;

    private WordToPdfUtil() {
        // Utility class, not meant to be instantiated.
    }

    /**
     * Converts the Word document at {@code inputPath} to a PDF at {@code outputPath}.
     *
     * @throws IllegalStateException if the conversion fails
     */
    public static void convertWordToPdf(String inputPath, String outputPath) {
        try {
            LocalConverter.make(getOfficeManager()).convert(new File(inputPath)).to(new File(outputPath)).execute();
        } catch (OfficeException e) {
            throw new IllegalStateException(
                    "Failed to convert Word to PDF (" + inputPath + " -> " + outputPath + "). "
                            + "Ensure LibreOffice is installed; office home resolved to: " + officeHome(), e);
        }
    }

    /**
     * Returns the lazily created, shared {@link LocalOfficeManager}. The LibreOffice
     * process is started on first use and stopped by a JVM shutdown hook.
     */
    private static LocalOfficeManager getOfficeManager() {
        LocalOfficeManager manager = officeManager;
        if (manager == null) {
            synchronized (WordToPdfUtil.class) {
                manager = officeManager;
                if (manager == null) {
                    manager = LocalOfficeManager.builder().officeHome(officeHome()).build();
                    try {
                        manager.start();
                    } catch (OfficeException e) {
                        throw new IllegalStateException(
                                "Failed to start the LibreOffice process; office home resolved to: "
                                        + officeHome() + " (override with env var " + OFFICE_HOME_ENV + ")", e);
                    }
                    officeManager = manager;
                    Runtime.getRuntime().addShutdownHook(new Thread(() -> {
                        try {
                            officeManager.stop();
                        } catch (OfficeException e) {
                            log.warn("Failed to stop the LibreOffice process on shutdown", e);
                        }
                    }));
                }
            }
        }
        return manager;
    }

    private static String officeHome() {
        String fromEnv = System.getenv(OFFICE_HOME_ENV);
        return (fromEnv == null || fromEnv.trim().isEmpty()) ? DEFAULT_OFFICE_HOME : fromEnv.trim();
    }
}
