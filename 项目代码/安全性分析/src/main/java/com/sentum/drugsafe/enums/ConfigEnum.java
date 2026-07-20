package com.sentum.drugsafe.enums;


public enum ConfigEnum {

    FEARS_END_DATE("fearsEndDate", "fears库最新更新结束日期", "2024-09-30"),
    FEARS_END_JD("fearsEndDateJd", "fears库最新更新结束日期", "2024年第四季度"),
    FEARS_END_DATE_JD("fearsEndJd", "jader库最新更新结束日期", "2025-01"),
    FEARS_END_DATE_JD2("fearsEndJd2", "jader库最新更新结束日期", "2025年1月");





    /**
     * 配置项Type
     */
    private String type;
    /**
     * 配置项名称或描述
     */
    private String name;
    /**
     * 配置项默认值
     */
    private String memo;

    ConfigEnum(String type, String name, String memo) {
        this.type = type;
        this.name = name;
        this.memo = memo;
    }

    public String getType() {
        return type;
    }

    public String getName() {
        return name;
    }

    public String getMemo() {
        return memo;
    }

    public static ConfigEnum getByType(String type) {
        for (ConfigEnum configEnum : ConfigEnum.values()) {
            if (configEnum.getType().equals(type)) {
                return configEnum;
            }
        }
        return null;
    }
}
