package com.sentum.evidencecomprehensive.utils;

import org.apache.commons.lang3.StringUtils;

/**
 * 文件操作工具类
 * @author zgm
 */
public class FileUtils {
    /**
     * 获取文件后缀名（不带点）.
     *
     * @return 如："jpg" or "".
     */
    public static String getFileExt(String fileName) {
        if (StringUtils.isBlank(fileName) || !fileName.contains(".")) {
            return "";
        } else {
            // 不带最后的点
            return fileName.substring(fileName.lastIndexOf(".") + 1);
        }
    }
}
