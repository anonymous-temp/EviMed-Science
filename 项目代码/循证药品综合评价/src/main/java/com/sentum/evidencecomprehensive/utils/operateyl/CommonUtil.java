package com.sentum.evidencecomprehensive.utils.operateyl;

import com.sentum.evidencecomprehensive.constants.Constants;
import org.apache.commons.lang3.StringUtils;

import java.io.File;

/**
 */
public class CommonUtil {
    public static String removeSeparatorFromSuffix(String pathName) {
        String tidiedPath = "";
        if (StringUtils.isNotBlank(pathName)) {
            tidiedPath = pathName;
            if (StringUtils.endsWith(pathName, Constants.PAD_LEFT_SLASH)) {
                tidiedPath = StringUtils.removeEnd(pathName, Constants.PAD_LEFT_SLASH);
                return removeSeparatorFromSuffix(tidiedPath);
            }
        }
        return tidiedPath;
    }

    public static String removeCommaFromSuffix(String str) {
        String tidiedPath = "";
        if (StringUtils.isNotBlank(str)) {
            tidiedPath = str;
            if (StringUtils.endsWith(str, Constants.SING_COMMA)) {
                tidiedPath = StringUtils.removeEnd(str, Constants.SING_COMMA);
                return removeCommaFromSuffix(tidiedPath);
            }
        }
        return tidiedPath;
    }
}
