package com.sentum.util;

import org.jodconverter.core.office.OfficeException;
import org.jodconverter.core.office.OfficeManager;
import org.jodconverter.local.LocalConverter;
import org.jodconverter.local.office.LocalOfficeManager;

import java.io.File;

/**
 * Converts Word documents to PDF using JODConverter on top of a local
 * LibreOffice/OpenOffice installation.
 *
 * <p>The office home is taken from the {@code EVIMED_OFFICE_HOME} environment
 * variable, falling back to the default macOS LibreOffice location.
 */
public class WordToPdfUtil {

    private static final String OFFICE_HOME_ENV = "EVIMED_OFFICE_HOME";
    private static final String DEFAULT_OFFICE_HOME = "/Applications/LibreOffice.app/Contents";

    private static volatile OfficeManager officeManager;

    private WordToPdfUtil() {
        // utility class
    }

    private static OfficeManager getOfficeManager() {
        OfficeManager manager = officeManager;
        if (manager == null) {
            synchronized (WordToPdfUtil.class) {
                manager = officeManager;
                if (manager == null) {
                    String officeHome = System.getenv(OFFICE_HOME_ENV);
                    if (officeHome == null || officeHome.trim().isEmpty()) {
                        officeHome = DEFAULT_OFFICE_HOME;
                    }
                    manager = LocalOfficeManager.builder()
                            .officeHome(officeHome)
                            .install()
                            .build();
                    try {
                        manager.start();
                    } catch (OfficeException e) {
                        throw new IllegalStateException(
                                "Failed to start local office manager (officeHome=" + officeHome + ")", e);
                    }
                    officeManager = manager;
                }
            }
        }
        return manager;
    }

    public static void convertWordToPdf(String inputPath, String outputPath) {
        File inputFile = new File(inputPath);
        File outputFile = new File(outputPath);
        try {
            LocalConverter.make(getOfficeManager())
                    .convert(inputFile)
                    .to(outputFile)
                    .execute();
        } catch (OfficeException e) {
            throw new IllegalStateException(
                    "Failed to convert Word to PDF: " + inputPath + " -> " + outputPath, e);
        }
    }
}
