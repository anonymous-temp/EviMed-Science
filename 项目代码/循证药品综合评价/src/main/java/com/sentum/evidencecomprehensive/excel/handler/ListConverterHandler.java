package com.sentum.evidencecomprehensive.excel.handler;

import org.mapstruct.Named;

import java.util.List;

/**
 * 
 */
@Named("CnEn")
public class ListConverterHandler {

    @Named("Content.ProductType")
    public String convertListToStringSupport(List<String> source) {
        return String.join((CharSequence) source, ",");
    }
}
